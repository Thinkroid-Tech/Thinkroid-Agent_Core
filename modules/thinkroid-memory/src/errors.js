export class NotImplementedError extends Error {
  constructor(msg = 'Not implemented') {
    super(msg);
    this.name = 'NotImplementedError';
  }
}

export class ValidationError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ValidationError';
  }
}

export class UnknownTagError extends Error {
  constructor(tagName) {
    super(`Unknown tag: ${tagName}`);
    this.name = 'UnknownTagError';
    this.tagName = tagName;
  }
}

export class MemoryNotFoundError extends Error {
  constructor(id) {
    super(`Memory not found: ${id}`);
    this.name = 'MemoryNotFoundError';
    this.memoryId = id;
  }
}
