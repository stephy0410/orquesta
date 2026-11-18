import { TestBed } from '@angular/core/testing';
import { IDB_FACTORY, ScanStorageService } from './scan-storage.service';

// Lightweight in-memory IDBFactory shim for JSDOM Vitest tests
function createInMemoryIdbFactory(): IDBFactory {
  const databases = new Map<string, Map<string, { keyPath: string; rows: Map<unknown, unknown>; indexes: Map<string, string> }>>();

  const makeReq = <T>(exec: (req: { result: T; error: DOMException | null; onsuccess: ((e: unknown) => void) | null; onerror: ((e: unknown) => void) | null }) => void): IDBRequest<T> => {
    const req: {
      result: T;
      error: DOMException | null;
      onsuccess: ((e: unknown) => void) | null;
      onerror: ((e: unknown) => void) | null;
    } = {
      result: undefined as unknown as T,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => exec(req));
    return req as unknown as IDBRequest<T>;
  };

  return {
    open(name: string) {
      let dbStores = databases.get(name);
      const isNew = !dbStores;
      if (!dbStores) {
        dbStores = new Map();
        databases.set(name, dbStores);
      }

      const dbObj = {
        objectStoreNames: {
          contains: (s: string) => dbStores!.has(s),
        },
        createObjectStore: (storeName: string, opts?: { keyPath?: string }) => {
          const storeData = {
            keyPath: opts?.keyPath ?? 'id',
            rows: new Map<unknown, unknown>(),
            indexes: new Map<string, string>(),
          };
          dbStores!.set(storeName, storeData);
          return {
            createIndex: (idxName: string, keyPath: string) => {
              storeData.indexes.set(idxName, keyPath);
            },
          };
        },
        transaction: (storeNames: string[]) => {
          let pendingOps = 0;
          let completed = false;
          const txObj: {
            oncomplete: (() => void) | null;
            onerror: (() => void) | null;
            onabort: (() => void) | null;
            error: Error | null;
            abort: () => void;
            objectStore: (s: string) => unknown;
          } = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            error: null,
            abort: () => {
              txObj.onabort?.();
            },
            objectStore: (storeName: string) => {
              const store = dbStores!.get(storeName)!;
              const scheduleDone = () => {
                pendingOps++;
                queueMicrotask(() => {
                  pendingOps--;
                  if (pendingOps === 0 && !completed) {
                    completed = true;
                    txObj.oncomplete?.();
                  }
                });
              };
              const makeOp = <T>(fn: () => T) =>
                makeReq<T>((req) => {
                  req.result = fn();
                  req.onsuccess?.({});
                  scheduleDone();
                });

              return {
                get: (k: unknown) => makeOp(() => store.rows.get(k)),
                put: (v: Record<string, unknown>) =>
                  makeOp(() => {
                    store.rows.set(v[store.keyPath], v);
                    return v[store.keyPath];
                  }),
                clear: () =>
                  makeOp(() => {
                    store.rows.clear();
                    return undefined;
                  }),
                getAll: () => makeOp(() => [...store.rows.values()]),
                count: () => makeOp(() => store.rows.size),
                index: (idxName: string) => {
                  const key = store.indexes.get(idxName)!;
                  const filter = (val: unknown) =>
                    [...store.rows.values()].filter(
                      (r) => (r as Record<string, unknown>)[key] === val,
                    );
                  return {
                    getAll: (val: unknown) => makeOp(() => filter(val)),
                    count: (val: unknown) => makeOp(() => filter(val).length),
                  };
                },
              };
            },
          };

          if (!storeNames.length) {
            queueMicrotask(() => txObj.oncomplete?.());
          }
          return txObj;
        },
        close: () => {},
        onversionchange: null,
      };

      const openReq: {
        result: unknown;
        error: null;
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = {
        result: dbObj,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };

      queueMicrotask(() => {
        if (isNew) {
          openReq.onupgradeneeded?.();
        }
        openReq.onsuccess?.();
      });

      return openReq as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

describe('ScanStorageService (IndexedDB RPO 0)', () => {
  let storage: ScanStorageService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: IDB_FACTORY, useValue: createInMemoryIdbFactory() }],
    });
    storage = TestBed.inject(ScanStorageService);
  });

  it('persists roster, searches by name & 6-digit code, and records monotonic RPO-0 scans', async () => {
    await storage.initSession({
      session_id: 'ses_1',
      session_token: 'tok_1',
      event_id: 'evt_1',
      rol: 'staff_checkin',
      device_id: 'dev_1',
      expira_en: new Date(Date.now() + 3600_000).toISOString(),
      roster_version: 1,
      revocation_version: 1,
      last_sequence: 0,
      last_acked_sequence: 0,
    });

    await storage.saveRoster(
      {
        event_id: 'evt_1',
        evento: {
          nombre: 'Boda',
          inicio: '2026-06-15T18:00:00Z',
          fin: '2026-06-16T01:00:00Z',
          estado: 'en_curso',
          timezone: 'America/Mexico_City',
        },
        roster_version: 1,
        generado_en: '2026-06-15T17:55:00Z',
        expira_en: '2026-06-16T02:00:00Z',
        firma: { alg: 'ES256', key_id: 'k-1', valor: 'sig' },
        key_publica_pem: 'PEM',
        revocaciones: {
          version: 1,
          emitida_en: '2026-06-15T17:55:00Z',
          ttl_horas: 2,
          vigente_hasta: '2026-06-15T19:55:00Z',
        },
        invitados: [
          { invitation_id: 'inv_1', nombre: 'Sofía Peña', codigo_corto: '483920' },
          { invitation_id: 'inv_2', nombre: 'Carlos Díaz', codigo_corto: '114503' },
        ],
      },
      '"roster-1"',
    );

    expect((await storage.searchRosterLocal('sofia')).length).toBe(1);
    expect((await storage.searchRosterLocal('114503'))[0].invitation_id).toBe('inv_2');

    const ev1 = await storage.recordScanAtomic({
      invitation_id: 'inv_1',
      scanned_at: '2026-06-15T18:10:00Z',
      token_sha256: 'abc',
      verdict_local: 'admitido',
      modo: 'camara',
      grantsAdmission: true,
    });
    const ev2 = await storage.recordScanAtomic({
      invitation_id: 'inv_2',
      scanned_at: '2026-06-15T18:11:00Z',
      token_sha256: 'def',
      verdict_local: 'admitido',
      modo: 'codigo_corto',
      grantsAdmission: true,
    });

    expect(ev1.sequence).toBe(1);
    expect(ev2.sequence).toBe(2);
    expect(await storage.isLocallyAdmitted('inv_1')).toBe(true);
    expect(storage.queueDepth()).toBe(2);

    await storage.markBatchSynced('b1', 2, [
      { sequence: 1, invitation_id: 'inv_1', verdict: 'admitido', tardio: false, duplicado: false },
      { sequence: 2, invitation_id: 'inv_2', verdict: 'admitido', tardio: false, duplicado: false },
    ]);
    expect(storage.queueDepth()).toBe(0);
    expect(storage.lastAckedSequence()).toBe(2);
  });
});
