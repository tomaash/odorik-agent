type DocumentData = Record<string, unknown>;
type Direction = "asc" | "desc";

const deleteValue = Symbol("delete-value");

function isPlainObject(value: unknown): value is DocumentData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as T;
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, clone(entry)]),
  ) as T;
}

function materialize(value: unknown): unknown | typeof deleteValue {
  const constructorName = value && typeof value === "object"
    ? value.constructor?.name
    : "";
  if (constructorName === "DeleteTransform") return deleteValue;
  if (constructorName === "ServerTimestampTransform") return "server-timestamp";
  if (Array.isArray(value)) return value.map((entry) => materialize(entry));
  if (!isPlainObject(value)) return value;
  const result: DocumentData = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = materialize(entry);
    if (next !== deleteValue) result[key] = next;
  }
  return result;
}

function mergeDocument(
  current: DocumentData,
  patch: DocumentData,
): DocumentData {
  const result = clone(current);
  for (const [key, rawValue] of Object.entries(patch)) {
    const value = materialize(rawValue);
    if (value === deleteValue) {
      delete result[key];
    } else if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeDocument(result[key], value);
    } else {
      result[key] = clone(value);
    }
  }
  return result;
}

function nestedValue(data: DocumentData, path: string): unknown {
  let value: unknown = data;
  for (const segment of path.split(".")) {
    if (!isPlainObject(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function setNestedValue(
  data: DocumentData,
  path: string,
  rawValue: unknown,
): void {
  const segments = path.split(".");
  const finalSegment = segments.pop();
  if (!finalSegment) throw new Error("A field path is required");
  let target = data;
  for (const segment of segments) {
    if (!isPlainObject(target[segment])) target[segment] = {};
    target = target[segment] as DocumentData;
  }
  const value = materialize(rawValue);
  if (value === deleteValue) delete target[finalSegment];
  else target[finalSegment] = clone(value);
}

function isDirectDocument(collectionPath: string, documentPath: string): boolean {
  const collectionSegments = collectionPath.split("/");
  const documentSegments = documentPath.split("/");
  return documentSegments.length === collectionSegments.length + 1
    && collectionSegments.every((segment, index) => documentSegments[index] === segment);
}

class MemoryDocumentSnapshot {
  constructor(
    readonly ref: MemoryDocumentReference,
    private readonly value: DocumentData | undefined,
  ) {}

  get id(): string {
    return this.ref.id;
  }

  get exists(): boolean {
    return this.value !== undefined;
  }

  data(): DocumentData | undefined {
    return this.value === undefined ? undefined : clone(this.value);
  }
}

class MemoryQuerySnapshot {
  readonly size: number;

  constructor(readonly docs: MemoryDocumentSnapshot[]) {
    this.size = docs.length;
  }
}

class MemoryQuery {
  constructor(
    protected readonly database: MemoryFirestore,
    protected readonly collectionPath: string,
    private readonly filters: Array<{
      field: string;
      value: unknown;
    }> = [],
    private readonly ordering: { field: string; direction: Direction } | null = null,
  ) {}

  where(field: string, operator: string, value: unknown): MemoryQuery {
    if (operator !== "==") throw new Error(`Unsupported in-memory operator ${operator}`);
    return new MemoryQuery(
      this.database,
      this.collectionPath,
      [...this.filters, { field, value }],
      this.ordering,
    );
  }

  orderBy(field: string, direction: Direction = "asc"): MemoryQuery {
    return new MemoryQuery(
      this.database,
      this.collectionPath,
      this.filters,
      { field, direction },
    );
  }

  async get(): Promise<MemoryQuerySnapshot> {
    const values = this.database.entries()
      .filter(([path]) => isDirectDocument(this.collectionPath, path))
      .filter(([, data]) => this.filters.every(
        (filter) => nestedValue(data, filter.field) === filter.value,
      ));
    if (this.ordering) {
      const { field, direction } = this.ordering;
      values.sort((left, right) => {
        const leftValue = String(nestedValue(left[1], field) ?? "");
        const rightValue = String(nestedValue(right[1], field) ?? "");
        const comparison = leftValue.localeCompare(rightValue);
        return direction === "asc" ? comparison : -comparison;
      });
    }
    return new MemoryQuerySnapshot(values.map(
      ([path, data]) => new MemoryDocumentSnapshot(
        this.database.documentReference(path),
        data,
      ),
    ));
  }
}

class MemoryCollectionReference extends MemoryQuery {
  constructor(
    database: MemoryFirestore,
    collectionPath: string,
  ) {
    super(database, collectionPath);
  }

  doc(id?: string): MemoryDocumentReference {
    return this.database.documentReference(
      `${this.collectionPath}/${id || this.database.nextId()}`,
    );
  }
}

class MemoryDocumentReference {
  readonly id: string;

  constructor(
    private readonly database: MemoryFirestore,
    readonly path: string,
  ) {
    this.id = path.split("/").at(-1) || "";
  }

  collection(name: string): MemoryCollectionReference {
    return this.database.collectionReference(`${this.path}/${name}`);
  }

  async get(): Promise<MemoryDocumentSnapshot> {
    return new MemoryDocumentSnapshot(this, this.database.read(this.path));
  }

  async set(
    data: DocumentData,
    options?: { merge?: boolean },
  ): Promise<void> {
    this.database.write(this.path, data, options?.merge === true);
  }

  async create(data: DocumentData): Promise<void> {
    this.database.create(this.path, data);
  }

  async update(...fieldsAndValues: unknown[]): Promise<void> {
    this.database.update(this.path, fieldsAndValues);
  }

  async delete(): Promise<void> {
    this.database.remove(this.path);
  }
}

class MemoryTransaction {
  private readonly writes: Array<() => void> = [];

  constructor(private readonly database: MemoryFirestore) {}

  async get(
    target: { get(): Promise<unknown> },
  ): Promise<unknown> {
    return target.get();
  }

  create(
    reference: MemoryDocumentReference,
    data: DocumentData,
  ): MemoryTransaction {
    this.writes.push(() => this.database.create(reference.path, data));
    return this;
  }

  set(
    reference: MemoryDocumentReference,
    data: DocumentData,
    options?: { merge?: boolean },
  ): MemoryTransaction {
    this.writes.push(() => this.database.write(
      reference.path,
      data,
      options?.merge === true,
    ));
    return this;
  }

  update(
    reference: MemoryDocumentReference,
    dataOrField: DocumentData | string,
    ...fieldsAndValues: unknown[]
  ): MemoryTransaction {
    this.writes.push(() => {
      if (typeof dataOrField === "string") {
        this.database.update(
          reference.path,
          [dataOrField, ...fieldsAndValues],
        );
      } else {
        this.database.patch(reference.path, dataOrField);
      }
    });
    return this;
  }

  delete(reference: MemoryDocumentReference): MemoryTransaction {
    this.writes.push(() => this.database.remove(reference.path));
    return this;
  }

  async commit(): Promise<void> {
    for (const write of this.writes) write();
  }
}

class MemoryWriteBatch {
  private readonly writes: Array<() => void> = [];

  constructor(private readonly database: MemoryFirestore) {}

  set(
    reference: MemoryDocumentReference,
    data: DocumentData,
    options?: { merge?: boolean },
  ): MemoryWriteBatch {
    this.writes.push(() => this.database.write(
      reference.path,
      data,
      options?.merge === true,
    ));
    return this;
  }

  update(
    reference: MemoryDocumentReference,
    ...fieldsAndValues: unknown[]
  ): MemoryWriteBatch {
    this.writes.push(() => this.database.update(reference.path, fieldsAndValues));
    return this;
  }

  delete(reference: MemoryDocumentReference): MemoryWriteBatch {
    this.writes.push(() => this.database.remove(reference.path));
    return this;
  }

  async commit(): Promise<void> {
    for (const write of this.writes) write();
  }
}

export class MemoryFirestore {
  private readonly documents = new Map<string, DocumentData>();
  private autoId = 0;

  seed(path: string, data: DocumentData): void {
    this.documents.set(path, clone(data));
  }

  read(path: string): DocumentData | undefined {
    const data = this.documents.get(path);
    return data === undefined ? undefined : clone(data);
  }

  list(collectionPath: string): DocumentData[] {
    return this.entries()
      .filter(([path]) => isDirectDocument(collectionPath, path))
      .map(([, data]) => clone(data));
  }

  entries(): Array<[string, DocumentData]> {
    return [...this.documents.entries()].map(([path, data]) => [path, clone(data)]);
  }

  nextId(): string {
    this.autoId += 1;
    return `auto-${this.autoId}`;
  }

  collection(path: string): MemoryCollectionReference {
    return this.collectionReference(path);
  }

  collectionReference(path: string): MemoryCollectionReference {
    return new MemoryCollectionReference(this, path);
  }

  doc(path: string): MemoryDocumentReference {
    return this.documentReference(path);
  }

  documentReference(path: string): MemoryDocumentReference {
    return new MemoryDocumentReference(this, path);
  }

  batch(): MemoryWriteBatch {
    return new MemoryWriteBatch(this);
  }

  async runTransaction<T>(
    updateFunction: (transaction: FirebaseFirestore.Transaction) => Promise<T>,
  ): Promise<T> {
    const transaction = new MemoryTransaction(this);
    const result = await updateFunction(
      transaction as unknown as FirebaseFirestore.Transaction,
    );
    await transaction.commit();
    return result;
  }

  asFirestore(): FirebaseFirestore.Firestore {
    return this as unknown as FirebaseFirestore.Firestore;
  }

  write(path: string, data: DocumentData, merge: boolean): void {
    const current = this.documents.get(path) || {};
    if (merge) {
      this.documents.set(path, mergeDocument(current, data));
      return;
    }
    const materialized = materialize(data);
    if (!isPlainObject(materialized)) throw new Error("Document data must be an object");
    this.documents.set(path, clone(materialized));
  }

  create(path: string, data: DocumentData): void {
    if (this.documents.has(path)) {
      const error = new Error(`Document ${path} already exists`) as Error & {
        code?: number | string;
      };
      error.code = 6;
      throw error;
    }
    this.write(path, data, false);
  }

  patch(path: string, data: DocumentData): void {
    const current = this.documents.get(path);
    if (!current) throw new Error(`Document ${path} does not exist`);
    this.documents.set(path, mergeDocument(current, data));
  }

  update(path: string, fieldsAndValues: unknown[]): void {
    const current = this.documents.get(path);
    if (!current) throw new Error(`Document ${path} does not exist`);
    if (fieldsAndValues.length % 2 !== 0) {
      throw new Error("Updates require field/value pairs");
    }
    const updated = clone(current);
    for (let index = 0; index < fieldsAndValues.length; index += 2) {
      const field = fieldsAndValues[index];
      if (typeof field !== "string") throw new Error("Only string field paths are supported");
      setNestedValue(updated, field, fieldsAndValues[index + 1]);
    }
    this.documents.set(path, updated);
  }

  remove(path: string): void {
    this.documents.delete(path);
  }
}
