/**
 * Autosave of the current project to IndexedDB (localStorage is too small for embedded images).
 * One record holds the latest state; it is validated with `parseProject` when read back, so an
 * autosave written by an older version migrates like a saved file.
 */

import type { Project } from '../core/index.ts';

const DB_NAME = 'graph-digitizer';
const STORE = 'autosave';
const KEY = 'current';

export interface AutosaveRecord {
  project: Project;
  /** Editor state the Project does not hold. */
  activeDatasetId: string;
  /** Lines whose point lists are collapsed in the table. */
  collapsed: string[];
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/** The stored record as raw data (validate it before use), or null when there is none. */
export async function readAutosave(): Promise<unknown> {
  const value = await withStore<unknown>('readonly', (s) => s.get(KEY));
  return value ?? null;
}

export async function writeAutosave(record: AutosaveRecord): Promise<void> {
  await withStore('readwrite', (s) => s.put(record, KEY));
}
