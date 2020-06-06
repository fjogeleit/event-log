import { IEventStore, IEvent, IMetadataMatcher, IReadModelConstructor } from '../';
import { IProjectionManager, ProjectionStatus, IState, IStream, IReadModel, IReadModelProjector } from '../projection';
import { Pool } from 'pg';
import { EVENT_STREAMS_TABLE, PROJECTIONS_TABLE } from '../';
import { ProjectorException, ProjectionNotFound } from '../exception';
import { PostgresClient } from "../helper/postgres";

const cloneDeep = require('lodash.clonedeep');

export class PostgresReadModelProjector<R extends IReadModel, T extends IState = IState> implements IReadModelProjector<R, T> {
  private state?: T;
  private initHandler?: () => T;
  private handlers?: {
    [event: string]: <S extends IEvent>(state: T, event: S) => T | Promise<T>;
  };
  private handler?: <S extends IEvent>(state: T, event: S) => T | Promise<T>;
  private metadataMatchers: { [streamName: string]: IMetadataMatcher } = {};

  private streamCreated: boolean = false;
  private isStopped: boolean = false;
  private eventCounter: number = 0;
  private lastLockUpdate?: Date;
  private streamPositions: { [stream: string]: number } = {};

  private lockTimeoutMs: number = 1000;
  private persistBlockSize: number = 1000;
  private updateLockThreshold: number = 0;
  public readonly readModel: R;

  private query: { all: boolean; streams: Array<string> } = {
    all: false,
    streams: [],
  };

  constructor(
    private readonly name: string,
    private readonly manager: IProjectionManager,
    private readonly eventStore: IEventStore,
    private readonly client: Pool,
    ReadModelConstructor: IReadModelConstructor<R>,
    private status: ProjectionStatus = ProjectionStatus.IDLE
  ) {
    this.readModel = new ReadModelConstructor(new PostgresClient(this.client));
  }

  init(callback: () => T): IReadModelProjector<R, T> {
    if (this.initHandler !== undefined) {
      throw ProjectorException.alreadyInitialized();
    }

    this.initHandler = callback;
    this.initHandler.bind(this);

    this.state = this.initHandler();

    return this;
  }

  fromAll(): IReadModelProjector<R, T> {
    if (this.query.all || this.query.streams.length > 0) {
      throw ProjectorException.fromWasAlreadyCalled();
    }

    this.query.all = true;

    return this;
  }

  fromStream(stream: IStream): IReadModelProjector<R, T> {
    if (this.query.all || this.query.streams.length > 0) {
      throw ProjectorException.fromWasAlreadyCalled();
    }

    this.query.streams.push(stream.streamName);
    this.metadataMatchers[stream.streamName] = stream.matcher;

    return this;
  }

  fromStreams(...streams: IStream[]): IReadModelProjector<R, T> {
    if (this.query.all || this.query.streams.length > 0) {
      throw ProjectorException.fromWasAlreadyCalled();
    }

    this.query.streams = streams.map(stream => stream.streamName);
    this.metadataMatchers = streams.reduce((matchers, stream) => {
      matchers[stream.streamName] = stream.matcher;

      return matchers;
    }, {});

    return this;
  }

  when(handlers: { [p: string]: (state: T, event: IEvent) => T }): IReadModelProjector<R, T> {
    if (this.handler || this.handlers) {
      throw ProjectorException.whenWasAlreadyCalled();
    }

    Object.values(handlers).forEach(handler => handler.bind(this));

    this.handlers = { ...handlers };

    return this;
  }

  whenAny(handler: (state: T, event: IEvent) => T): IReadModelProjector<R, T> {
    if (this.handler || this.handlers) {
      throw ProjectorException.whenWasAlreadyCalled();
    }

    handler.bind(this);

    this.handler = handler;

    return this;
  }

  async emit(event: IEvent): Promise<void> {
    if (this.streamCreated === false && (await this.eventStore.hasStream(this.name)) === false) {
      await this.eventStore.createStream(this.name);
      this.streamCreated = true;
    }

    this.linkTo(this.name, event);
  }

  async linkTo(streamName: string, event: IEvent): Promise<void> {
    if ((await this.eventStore.hasStream(streamName)) === false) {
      await this.eventStore.createStream(streamName);
    }

    await this.eventStore.appendTo(streamName, [event]);
  }

  async delete(deleteProjection: boolean = true): Promise<void> {
    const result = await this.client.query(`DELETE FROM ${PROJECTIONS_TABLE} WHERE "name" = $1`, [this.name]);

    if (result.rowCount === 0) {
      throw ProjectionNotFound.withName(this.name);
    }

    if (deleteProjection) {
      await this.readModel.delete();
    }

    this.isStopped = true;
    this.state = undefined;

    if (this.initHandler !== undefined) {
      this.state = this.initHandler();
    }

    this.streamPositions = {};
  }

  async reset(): Promise<void> {
    this.streamPositions = {};
    await this.readModel.reset();
    this.state = undefined;

    if (this.initHandler !== undefined) {
      this.state = this.initHandler();
    }

    const result = await this.client.query(`UPDATE ${PROJECTIONS_TABLE} SET status = $1, state = $2, position = $3 WHERE "name" = $4`, [
      ProjectionStatus.IDLE,
      JSON.stringify(this.state || {}),
      JSON.stringify(this.streamPositions),
      this.name,
    ]);

    if (result.rowCount === 0) {
      throw ProjectionNotFound.withName(this.name);
    }

    try {
      await this.eventStore.deleteStream(this.name);
    } catch (e) {
      console.error(e);
    }
  }

  async stop(): Promise<void> {
    await this.persist();

    this.isStopped = true;

    await this.manager.idleProjection(this.name);

    this.status = ProjectionStatus.IDLE;
  }

  getName(): string {
    return this.name;
  }

  getState(): T {
    return this.state;
  }

  async run(keepRunning: boolean = false): Promise<void> {
    if (!this.handler && !this.handlers) {
      throw ProjectorException.noHandler();
    }

    if (!this.state) {
      throw ProjectorException.stateWasNotInitialised();
    }

    switch (await this.fetchRemoteStatus()) {
      case ProjectionStatus.STOPPING:
        await this.load();
        await this.stop();
        break;
      case ProjectionStatus.DELETING:
        await this.delete();
        break;
      case ProjectionStatus.DELETING_INCL_EMITTED_EVENTS:
        await this.delete(true);
        break;
      case ProjectionStatus.RESETTING:
        await this.reset();

        if (keepRunning) {
          await this.startAgain();
        }
        break;
    }

    if ((await this.projectionExists()) === false) {
      await this.createProjection();
    }

    await this.acquireLock();

    if ((await this.readModel.isInitialized()) === false) {
      await this.readModel.init();
    }

    await this.prepareStreamPosition();
    await this.load();

    this.isStopped = false;

    try {
      do {
        const evenStream = await this.eventStore.mergeAndLoad(
          ...Object.entries(this.streamPositions).map(([streamName, position]) => ({
            streamName,
            fromNumber: position + 1,
            matcher: this.metadataMatchers[streamName],
          }))
        );

        if (this.handler) {
          await this.handleStreamWithSingleHandler(evenStream);
        } else {
          await this.handleStreamWithHandlers(evenStream);
        }

        if (0 === this.eventCounter) {
          await new Promise(resolve =>
            setTimeout(() => {
              resolve();
            }, 100)
          );

          await this.updateLock();
        } else {
          await this.persist();
        }

        this.eventCounter = 0;

        switch (await this.fetchRemoteStatus()) {
          case ProjectionStatus.STOPPING:
            await this.stop();
            break;
          case ProjectionStatus.DELETING:
            await this.delete();
            break;
          case ProjectionStatus.DELETING_INCL_EMITTED_EVENTS:
            await this.delete(true);
            break;
          case ProjectionStatus.RESETTING:
            await this.reset();

            if (keepRunning) {
              await this.startAgain();
            }
            break;
        }

        await this.prepareStreamPosition();
      } while (keepRunning && !this.isStopped);
    } catch (e) {
      console.error(e);
    } finally {
      this.releaseLock();
    }
  }

  public progressEvent(event: string): boolean {
    if (this.handler) {
      return true;
    }

    return Object.keys(this.handlers).includes(event);
  }

  private async handleStreamWithSingleHandler(eventStreams: AsyncIterable<IEvent>) {
    for await (const event of eventStreams) {
      this.streamPositions[event.metadata.stream] = event.no;
      this.eventCounter++;

      this.state = cloneDeep(await this.handler(this.state, event));

      await this.persistAndFetchRemoteStatusWhenBlockSizeThresholdReached();

      if (this.isStopped) {
        break;
      }
    }
  }

  private async handleStreamWithHandlers(eventStreams: AsyncIterable<IEvent>) {
    for await (const event of eventStreams) {
      this.streamPositions[event.metadata.stream] = event.no;
      this.eventCounter++;

      if (this.handlers[event.name] === undefined) {
        await this.persistAndFetchRemoteStatusWhenBlockSizeThresholdReached();

        if (this.isStopped) {
          break;
        }

        continue;
      }

      this.state = cloneDeep(await this.handlers[event.name](this.state, event));

      if (this.isStopped) {
        break;
      }
    }
  }

  private async persist(): Promise<void> {
    await this.readModel.persist();

    const result = await this.client.query(`UPDATE ${PROJECTIONS_TABLE} SET locked_until = $1, state = $2, position = $3 WHERE "name" = $4`, [
      this.createLockUntil(new Date()),
      JSON.stringify(this.state || {}),
      JSON.stringify(this.streamPositions),
      this.name,
    ]);

    if (result.rowCount === 0) {
      throw ProjectionNotFound.withName(this.name);
    }
  }

  private async persistAndFetchRemoteStatusWhenBlockSizeThresholdReached() {
    if (this.eventCounter !== this.persistBlockSize) return;

    await this.persist();
    this.eventCounter = 0;

    this.status = await this.fetchRemoteStatus();

    if ([ProjectionStatus.IDLE, ProjectionStatus.RUNNING].includes(this.status)) return;

    this.isStopped = true;
  }

  private async load(): Promise<void> {
    const result = await this.client.query<{
      position: { [streamName: string]: number };
      state: T;
    }>(`SELECT position, state FROM ${PROJECTIONS_TABLE} WHERE name = $1 LIMIT 1`, [this.name]);

    if (result.rowCount === 0) {
      throw ProjectionNotFound.withName(this.name);
    }

    this.streamPositions = {
      ...this.streamPositions,
      ...result.rows[0].position,
    };
    this.state = { ...result.rows[0].state };
  }

  private async prepareStreamPosition(): Promise<void> {
    let streamPositions = {};

    if (this.query.all) {
      const result = await this.client.query<{ real_stream_name: string }>(
        `SELECT real_stream_name FROM ${EVENT_STREAMS_TABLE} WHERE real_stream_name NOT LIKE '$%'`
      );

      streamPositions = result.rows.reduce((acc, stream) => {
        acc[stream.real_stream_name] = 0;

        return acc;
      }, {});
    }

    if (this.query.streams.length > 0) {
      streamPositions = this.query.streams.reduce((acc, streamName) => {
        acc[streamName] = 0;

        return acc;
      }, {});
    }

    this.streamPositions = { ...streamPositions, ...this.streamPositions };
  }

  private async fetchRemoteStatus(): Promise<ProjectionStatus> {
    try {
      return await this.manager.fetchProjectionStatus(this.name);
    } catch (e) {
      return ProjectionStatus.RUNNING;
    }
  }

  private async startAgain() {
    this.isStopped = false;
    const now = new Date();

    const result = await this.client.query(`UPDATE ${PROJECTIONS_TABLE} SET locked_until = $1, status = $2 WHERE "name" = $4`, [
      this.createLockUntil(now),
      ProjectionStatus.RUNNING,
      this.name,
    ]);

    if (result.rowCount === 0) {
      throw ProjectionNotFound.withName(this.name);
    }

    this.status = ProjectionStatus.RUNNING;
    this.lastLockUpdate = now;
  }

  private async projectionExists(): Promise<boolean> {
    const result = await this.client.query<{ name: string }>(`SELECT name FROM ${PROJECTIONS_TABLE} WHERE name = $1;`, [this.name]);

    return result.rowCount === 1;
  }

  private async createProjection(): Promise<void> {
    await this.client.query(`INSERT INTO ${PROJECTIONS_TABLE} (name, position, state, status, locked_until) VALUES ($1, '{}', '{}', $2, NULL)`, [
      this.name,
      this.status,
    ]);
  }

  private async acquireLock(): Promise<void> {
    const now = new Date();

    await this.client.query(
      `UPDATE ${PROJECTIONS_TABLE} SET locked_until = $1, status = $2 WHERE name = $3 AND (locked_until IS NULL OR locked_until < $4)`,
      [this.createLockUntil(now), ProjectionStatus.RUNNING, this.name, now]
    );

    this.status = ProjectionStatus.RUNNING;
    this.lastLockUpdate = now;
  }

  private async updateLock(): Promise<void> {
    const now = new Date();

    if (this.shouldUpdateLock(now) === false) {
      return;
    }

    await this.client.query(`UPDATE ${PROJECTIONS_TABLE} SET locked_until = $1 WHERE name = $2;`, [this.createLockUntil(now), this.name]);

    this.lastLockUpdate = now;
  }

  private async releaseLock() {
    await this.client.query(`UPDATE ${PROJECTIONS_TABLE} SET locked_until = NULL, status = $1 WHERE name = $2`, [ProjectionStatus.IDLE, this.name]);
  }

  private createLockUntil(from: Date) {
    const lockTimeoutMs = this.lockTimeoutMs % 1000;
    return new Date(from.getTime() + (this.lockTimeoutMs - lockTimeoutMs) + lockTimeoutMs);
  }

  private shouldUpdateLock(now: Date): boolean {
    if (this.lastLockUpdate === undefined || this.updateLockThreshold === 0) {
      return true;
    }

    return new Date(this.lastLockUpdate.getTime() + this.updateLockThreshold) <= now;
  }
}
