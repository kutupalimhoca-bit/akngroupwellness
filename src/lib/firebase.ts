/**
 * Clean Local Document Store (Zero Firebase Credentials / Zero External Cloud Dependencies)
 * Replaces external Firebase SDK calls with an isolated local document store
 * so the application starts completely from scratch with zero pre-existing cloud data.
 */

export type Unsubscribe = () => void;
export type Firestore = Record<string, any>;
export type Auth = {
  currentUser: any | null;
};

export const firebaseConfig = {
  apiKey: "AIzaSyDHPt4cBGU2La3RSKhtB2vy2_9rQIhVqW8",
  authDomain: "akngroupwellness.firebaseapp.com",
  projectId: "akngroupwellness",
  storageBucket: "akngroupwellness.firebasestorage.app",
  messagingSenderId: "371051918604",
  appId: "1:371051918604:web:53bee80fb90a9763160529"
};

const CLEAN_RESET_FLAG_KEY = 'frekans_clean_slate_initialized_v4';
const LOCAL_DOC_STORE_PREFIX = 'frekans_doc_col_v4_';

/**
 * Wipes all legacy cached data and starts the application completely from scratch.
 */
export function wipeAllLocalApplicationData(): void {
  if (typeof window === 'undefined') return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (
        k &&
        (k.startsWith('aurabio_') ||
          k.startsWith('firebase:') ||
          k.startsWith('firestore') ||
          k.startsWith(LOCAL_DOC_STORE_PREFIX))
      ) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // ignore storage errors
  }

  // Also delete any legacy Firebase IndexedDB databases from the browser if present
  try {
    if (typeof indexedDB !== 'undefined') {
      const legacyDbs = [
        'firebaseLocalStorageDb',
        'firebase-installations-database',
        'firestore/[DEFAULT]/akngroupfrekans/main',
      ];
      legacyDbs.forEach((dbName) => {
        try {
          indexedDB.deleteDatabase(dbName);
        } catch {
          // ignore
        }
      });
    }
  } catch {
    // ignore
  }
}

// Run a one-time clean-slate reset so any leftover old Firebase cache in the browser is purged
if (typeof window !== 'undefined') {
  try {
    if (localStorage.getItem(CLEAN_RESET_FLAG_KEY) !== '1') {
      wipeAllLocalApplicationData();
      localStorage.setItem(CLEAN_RESET_FLAG_KEY, '1');
    }
  } catch {
    // ignore
  }
}

type CollectionMap = Record<string, Record<string, any>>;
const memoryStore: Record<string, CollectionMap> = {};
const listeners = new Map<string, Set<() => void>>();

function getCollectionMap(colName: string): Record<string, any> {
  if (memoryStore[colName]) {
    return memoryStore[colName];
  }
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(`${LOCAL_DOC_STORE_PREFIX}${colName}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          memoryStore[colName] = parsed;
          return memoryStore[colName];
        }
      }
    } catch {
      // ignore
    }
  }
  memoryStore[colName] = {};
  return memoryStore[colName];
}

function persistCollectionMap(colName: string): void {
  if (typeof window !== 'undefined') {
    try {
      const col = memoryStore[colName] || {};
      localStorage.setItem(`${LOCAL_DOC_STORE_PREFIX}${colName}`, JSON.stringify(col));
    } catch {
      // ignore quota errors
    }
  }
  notifyListeners(colName);
}

function notifyListeners(colName: string, docId?: string): void {
  const colSet = listeners.get(`col:${colName}`);
  if (colSet) {
    colSet.forEach((cb) => {
      try {
        cb();
      } catch {
        // ignore
      }
    });
  }
  if (docId) {
    const docSet = listeners.get(`doc:${colName}/${docId}`);
    if (docSet) {
      docSet.forEach((cb) => {
        try {
          cb();
        } catch {
          // ignore
        }
      });
    }
  }
}

// Increment sentinel support
interface IncrementSentinel {
  __isIncrementSentinel: true;
  delta: number;
}

export function increment(n: number): IncrementSentinel {
  return { __isIncrementSentinel: true, delta: Number(n) || 0 };
}

export function serverTimestamp(): string {
  return new Date().toISOString();
}

function applyFieldUpdates(existing: Record<string, any>, updates: Record<string, any>): Record<string, any> {
  const next: Record<string, any> = { ...existing };
  for (const [k, v] of Object.entries(updates || {})) {
    if (v && typeof v === 'object' && (v as IncrementSentinel).__isIncrementSentinel) {
      const currentVal = Number(next[k]) || 0;
      next[k] = currentVal + (v as IncrementSentinel).delta;
    } else {
      next[k] = v;
    }
  }
  return next;
}

export interface LocalCollectionRef {
  __type: 'collection';
  path: string;
  constraints?: QueryConstraint[];
}

export interface LocalDocRef {
  __type: 'doc';
  collectionPath: string;
  id: string;
  path: string;
}

export interface QueryConstraint {
  type: 'where' | 'limit' | 'orderBy';
  field?: string;
  op?: string;
  value?: any;
  count?: number;
  direction?: 'asc' | 'desc';
}

export function collection(_db: any, path: string, ...pathSegments: string[]): LocalCollectionRef {
  const fullPath = [path, ...pathSegments].filter(Boolean).join('/');
  return {
    __type: 'collection',
    path: fullPath,
  };
}

export function doc(_dbOrCol: any, pathOrId?: string, ...pathSegments: string[]): LocalDocRef {
  if (_dbOrCol && _dbOrCol.__type === 'collection') {
    const generatedId =
      pathOrId || `doc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    return {
      __type: 'doc',
      collectionPath: _dbOrCol.path,
      id: generatedId,
      path: `${_dbOrCol.path}/${generatedId}`,
    };
  }
  const segments = [pathOrId, ...pathSegments].filter(Boolean) as string[];
  const docId =
    segments.length >= 2
      ? segments[segments.length - 1]
      : `doc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const colPath = segments.length >= 2 ? segments.slice(0, -1).join('/') : segments[0] || 'default';
  return {
    __type: 'doc',
    collectionPath: colPath,
    id: docId,
    path: `${colPath}/${docId}`,
  };
}

export function where(field: string, op: string, value: any): QueryConstraint {
  return { type: 'where', field, op, value };
}

export function limit(count: number): QueryConstraint {
  return { type: 'limit', count };
}

export function orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): QueryConstraint {
  return { type: 'orderBy', field, direction };
}

export function query(colRef: LocalCollectionRef, ...constraints: QueryConstraint[]): LocalCollectionRef {
  return {
    ...colRef,
    constraints: [...(colRef.constraints || []), ...constraints.filter(Boolean)],
  };
}

function evaluateQueryDocs(colRef: LocalCollectionRef): Array<{ id: string; data: () => any; exists: () => boolean }> {
  const colMap = getCollectionMap(colRef.path);
  let entries = Object.entries(colMap).map(([id, rawData]) => ({
    id,
    rawData,
  }));

  const constraints = colRef.constraints || [];
  for (const c of constraints) {
    if (c.type === 'where' && c.field) {
      entries = entries.filter(({ rawData }) => {
        const fieldVal = rawData?.[c.field!];
        switch (c.op) {
          case '==':
            return fieldVal === c.value;
          case '!=':
            return fieldVal !== c.value;
          case '>':
            return fieldVal > c.value;
          case '>=':
            return fieldVal >= c.value;
          case '<':
            return fieldVal < c.value;
          case '<=':
            return fieldVal <= c.value;
          case 'in':
            return Array.isArray(c.value) && c.value.includes(fieldVal);
          case 'array-contains':
            return Array.isArray(fieldVal) && fieldVal.includes(c.value);
          default:
            return true;
        }
      });
    } else if (c.type === 'orderBy' && c.field) {
      const dir = c.direction === 'desc' ? -1 : 1;
      entries.sort((a, b) => {
        const va = a.rawData?.[c.field!];
        const vb = b.rawData?.[c.field!];
        if (va === vb) return 0;
        return va > vb ? dir : -dir;
      });
    } else if (c.type === 'limit' && typeof c.count === 'number') {
      entries = entries.slice(0, c.count);
    }
  }

  return entries.map(({ id, rawData }) => ({
    id,
    exists: () => true,
    data: () => ({ ...rawData }),
  }));
}

export async function getDoc(docRef: LocalDocRef) {
  const colMap = getCollectionMap(docRef.collectionPath);
  const item = colMap[docRef.id];
  return {
    id: docRef.id,
    exists: () => item !== undefined,
    data: () => (item !== undefined ? { ...item } : undefined),
  };
}

export async function getDocs(colOrQuery: LocalCollectionRef) {
  const docs = evaluateQueryDocs(colOrQuery);
  return {
    empty: docs.length === 0,
    size: docs.length,
    docs,
    forEach: (cb: (d: { id: string; data: () => any; exists: () => boolean }) => void) => {
      docs.forEach(cb);
    },
  };
}

export async function setDoc(
  docRef: LocalDocRef,
  data: Record<string, any>,
  options?: { merge?: boolean }
): Promise<void> {
  const colMap = getCollectionMap(docRef.collectionPath);
  if (options?.merge && colMap[docRef.id]) {
    colMap[docRef.id] = applyFieldUpdates(colMap[docRef.id], data);
  } else {
    colMap[docRef.id] = applyFieldUpdates({}, data);
  }
  persistCollectionMap(docRef.collectionPath);
  notifyListeners(docRef.collectionPath, docRef.id);
}

export async function updateDoc(
  docRef: LocalDocRef,
  data: Record<string, any>
): Promise<void> {
  const colMap = getCollectionMap(docRef.collectionPath);
  const current = colMap[docRef.id] || {};
  colMap[docRef.id] = applyFieldUpdates(current, data);
  persistCollectionMap(docRef.collectionPath);
  notifyListeners(docRef.collectionPath, docRef.id);
}

export async function deleteDoc(docRef: LocalDocRef): Promise<void> {
  const colMap = getCollectionMap(docRef.collectionPath);
  if (docRef.id in colMap) {
    delete colMap[docRef.id];
    persistCollectionMap(docRef.collectionPath);
    notifyListeners(docRef.collectionPath, docRef.id);
  }
}

export function onSnapshot(
  target: LocalDocRef | LocalCollectionRef,
  onNext: (snapshot: any) => void,
  _onError?: (err: any) => void
): Unsubscribe {
  if (target.__type === 'doc') {
    const key = `doc:${target.collectionPath}/${target.id}`;
    const emit = () => {
      const colMap = getCollectionMap(target.collectionPath);
      const item = colMap[target.id];
      onNext({
        id: target.id,
        exists: () => item !== undefined,
        data: () => (item !== undefined ? { ...item } : undefined),
      });
    };
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key)!.add(emit);
    setTimeout(emit, 0);
    return () => {
      listeners.get(key)?.delete(emit);
    };
  }

  const key = `col:${target.path}`;
  const emit = () => {
    const docs = evaluateQueryDocs(target);
    onNext({
      empty: docs.length === 0,
      size: docs.length,
      docs,
      forEach: (cb: (d: any) => void) => docs.forEach(cb),
    });
  };
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key)!.add(emit);
  setTimeout(emit, 0);
  return () => {
    listeners.get(key)?.delete(emit);
  };
}

export async function runTransaction<T>(
  _db: any,
  updateFunction: (transaction: {
    get: (docRef: LocalDocRef) => Promise<{ id: string; exists: () => boolean; data: () => any }>;
    set: (docRef: LocalDocRef, data: Record<string, any>, options?: { merge?: boolean }) => any;
    update: (docRef: LocalDocRef, data: Record<string, any>) => any;
    delete: (docRef: LocalDocRef) => any;
  }) => Promise<T>
): Promise<T> {
  const pendingWrites: Array<() => Promise<void>> = [];
  const tx = {
    async get(docRef: LocalDocRef) {
      return getDoc(docRef);
    },
    set(docRef: LocalDocRef, data: Record<string, any>, options?: { merge?: boolean }) {
      pendingWrites.push(() => setDoc(docRef, data, options));
      return tx;
    },
    update(docRef: LocalDocRef, data: Record<string, any>) {
      pendingWrites.push(() => updateDoc(docRef, data));
      return tx;
    },
    delete(docRef: LocalDocRef) {
      pendingWrites.push(() => deleteDoc(docRef));
      return tx;
    },
  };
  const result = await updateFunction(tx);
  for (const op of pendingWrites) {
    await op();
  }
  return result;
}

export function writeBatch(_db?: any) {
  const ops: Array<() => Promise<void>> = [];
  return {
    set(docRef: LocalDocRef, data: Record<string, any>, options?: { merge?: boolean }) {
      ops.push(() => setDoc(docRef, data, options));
    },
    update(docRef: LocalDocRef, data: Record<string, any>) {
      ops.push(() => updateDoc(docRef, data));
    },
    delete(docRef: LocalDocRef) {
      ops.push(() => deleteDoc(docRef));
    },
    async commit() {
      for (const op of ops) {
        await op();
      }
    },
  };
}

// App & Auth compatibility stubs (no external Firebase calls)
export function initializeApp(_config?: any) {
  return {};
}
export function getApps() {
  return [{}];
}
export function getApp() {
  return {};
}
export function initializeFirestore(_app?: any, _settings?: any): Firestore {
  return {};
}
export function getFirestore(_app?: any): Firestore {
  return {};
}
export function setLogLevel(_level?: string) {}
export function persistentLocalCache(_settings?: any) {
  return {};
}
export function persistentMultipleTabManager() {
  return {};
}

export const db: Firestore = {};
export const auth: Auth = { currentUser: null };
export const browserLocalPersistence = {};

export function getAuth(_app?: any): Auth {
  return auth;
}
export async function setPersistence(_auth?: any, _persistence?: any): Promise<void> {}

export function getFunctions(_app?: any, _region?: string) {
  return {};
}
export const functions = getFunctions(undefined, 'europe-west1');

export async function ensureFirebaseAuthUser(_email?: string, _password?: string): Promise<any> {
  return null;
}

export default {
  db,
  auth,
  ensureFirebaseAuthUser,
  firebaseConfig,
  wipeAllLocalApplicationData,
};
