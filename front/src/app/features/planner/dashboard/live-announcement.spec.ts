import { DashboardEventItem } from '../../../core/api/models';
import { LiveAnnouncer, buildLiveAnnouncement } from './live-announcement';

function ev(id: string, nombre: string, asistentes: number, confirmados: number): DashboardEventItem {
  return {
    event_id: id,
    nombre,
    estado: 'en_curso',
    contadores: {
      invitados: 100,
      confirmados,
      asistentes,
      aun_no_llegaron: confirmados - asistentes,
      pendientes_sincronizar: 0,
      entregas_parciales: 0,
    },
    no_show: null,
    pendientes: { valor: 0, estado: 'conocido' },
    frescura: { t_ingest: null, t_visible: '2026-11-21T20:00:00Z', lag_ms: 120, lag_p95_ms: 300 },
  };
}

describe('Anuncios del tablero en vivo (issue #9, aria-live con throttle)', () => {
  it('resume llegadas y confirmaciones por evento', () => {
    const msg = buildLiveAnnouncement(
      [ev('a', 'Boda Robles', 10, 80), ev('b', 'XV Fernanda', 0, 40)],
      [ev('a', 'Boda Robles', 13, 81), ev('b', 'XV Fernanda', 0, 40)],
    );
    expect(msg).toBe('Boda Robles: 3 llegadas y 1 confirmación; van 13 de 81 confirmados.');
  });

  it('no anuncia si nada cambió', () => {
    expect(buildLiveAnnouncement([ev('a', 'Boda', 1, 2)], [ev('a', 'Boda', 1, 2)])).toBeNull();
  });

  it('agrupa cambios dentro de la ventana mínima y los suma en el siguiente anuncio', () => {
    const live = new LiveAnnouncer(15_000);
    expect(live.push([ev('a', 'Boda', 0, 50)], 0)).toBeNull(); // línea base
    expect(live.push([ev('a', 'Boda', 2, 50)], 3_000)).toBe(
      'Boda: 2 llegadas; van 2 de 50 confirmados.',
    );
    // Dentro de la ventana: silencio aunque haya cambios
    expect(live.push([ev('a', 'Boda', 5, 50)], 6_000)).toBeNull();
    expect(live.push([ev('a', 'Boda', 9, 50)], 12_000)).toBeNull();
    // Pasada la ventana: un solo anuncio con todo lo acumulado desde el anterior
    expect(live.push([ev('a', 'Boda', 9, 50)], 19_000)).toBe(
      'Boda: 7 llegadas; van 9 de 50 confirmados.',
    );
  });
});
