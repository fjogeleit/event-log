export class ProjectionNotFound extends Error {
  static withName(name: string): ProjectionNotFound {
    return new this(`Aggregate with name ${name} was not found`);
  }
}
