export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export class BusinessError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    detail: string,
    public readonly fieldErrors?: FieldError[],
  ) {
    super(detail);
    this.name = 'BusinessError';
  }
}

export const badRequest = (code: string, detail: string, fieldErrors?: FieldError[]) =>
  new BusinessError(400, code, detail, fieldErrors);

export const unauthorized = (detail = 'Authentication is required.') =>
  new BusinessError(401, 'unauthorized', detail);

export const forbidden = (detail = 'The actor is not allowed to perform this operation.') =>
  new BusinessError(403, 'forbidden', detail);

export const notFound = (resource: string) =>
  new BusinessError(404, 'not_found', `${resource} was not found.`);

export const conflict = (code: string, detail: string) => new BusinessError(409, code, detail);

export const versionConflict = (currentVersion: number) =>
  new BusinessError(
    412,
    'version_conflict',
    `The resource version changed. Current version is ${currentVersion}.`,
  );

export const unprocessable = (code: string, detail: string) => new BusinessError(422, code, detail);

export const dependencyUnavailable = (detail: string) =>
  new BusinessError(503, 'dependency_unavailable', detail);
