import { TestBed } from '@angular/core/testing';
import { ORQUESTA_API_BASE_URL } from '../api/api-config';
import { ConnectivityService, HEALTH_FETCH_FN } from './connectivity.service';

describe('ConnectivityService', () => {
  it('detects server reachability via /health and avoids false positives when /health fails', async () => {
    let healthy = true;
    const mockFetch = async () => new Response(null, { status: healthy ? 200 : 503 });

    TestBed.configureTestingModule({
      providers: [
        { provide: ORQUESTA_API_BASE_URL, useValue: 'https://api.orquesta.test' },
        { provide: HEALTH_FETCH_FN, useValue: mockFetch },
      ],
    });

    const service = TestBed.inject(ConnectivityService);
    const ok1 = await service.checkHealth();
    expect(ok1).toBe(true);
    expect(service.isOnline()).toBe(true);

    healthy = false;
    const ok2 = await service.checkHealth();
    expect(ok2).toBe(false);
    expect(service.serverReachable()).toBe(false);
    expect(service.isOnline()).toBe(false);
  });
});
