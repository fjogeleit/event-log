import { AggregateConstructor, EventStore, IEvent, IEventConstructor } from "../index";

export interface IAggregate {
  popEvents: () => IEvent[]
  fromHistory: (events: IEvent[]) => IAggregate
}

export interface RepositoryConfiguration<T> {
  eventStore: EventStore;
  aggregate: AggregateConstructor<T>;
  events: IEventConstructor[];
  streamName: string;
}

export interface Repository<T extends IAggregate> {
  save: (aggregate: T) => Promise<void>
  get: (aggregateId: string) => Promise<T>
}
