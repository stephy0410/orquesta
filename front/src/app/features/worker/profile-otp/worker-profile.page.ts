import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../core/api/api.service';
import { OrquestaApiError } from '../../../core/api/api-config';
import { humanize } from '../../../shared/labels';
import {
  COMMON_LANGUAGES,
  SERVICES_BY_CATEGORY,
  TarifaUnidad,
  WORKER_CATEGORIES,
  WORKER_ZONES,
  WorkerProfileDto,
  WorkerProfileEstado,
  WorkerProfileStatusResponse,
  WorkerTipo,
} from '../../../core/api/models';

@Component({
  selector: 'app-worker-profile-page',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './worker-profile.page.html',
  styleUrl: './worker-profile.page.scss',
})
export class WorkerProfilePage implements OnInit {
  private readonly api = inject(ApiService);

  readonly allCategories = WORKER_CATEGORIES;
  readonly allZones = WORKER_ZONES;
  readonly allLanguages = COMMON_LANGUAGES;

  readonly hasExistingProfile = signal(false);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);

  readonly label = humanize;
  readonly estado = signal<WorkerProfileEstado>('borrador');
  readonly eventosCompletados = signal<number>(0);
  readonly emailVerified = signal(false);
  readonly phoneVerified = signal(false);

  readonly tipo = signal<WorkerTipo>('persona');
  readonly plazasOfrecidas = signal<number>(1);
  readonly nombrePublico = signal<string>('');
  readonly categorias = signal<string[]>(['mesero']);
  readonly servicios = signal<string[]>([]);
  readonly tarifaMonto = signal<number>(500);
  readonly tarifaMoneda = signal<string>('MXN');
  readonly tarifaUnidad = signal<TarifaUnidad>('hora');
  readonly zonas = signal<string[]>(['sur']);
  readonly radioKm = signal<number | null>(25);
  readonly idiomas = signal<string[]>(['es']);
  readonly aniosExperiencia = signal<number>(2);
  readonly telefonoE164 = signal<string>('');
  readonly fotosText = signal<string>('');
  readonly referenciasText = signal<string>('');

  // OTP challenge states
  readonly emailDesafioId = signal<string | null>(null);
  readonly emailOtp = signal<string>('');
  readonly phoneDesafioId = signal<string | null>(null);
  readonly phoneOtp = signal<string>('');

  readonly availableServices = computed(() => {
    const out = new Set<string>();
    for (const cat of this.categorias()) {
      for (const srv of SERVICES_BY_CATEGORY[cat] ?? []) {
        out.add(srv);
      }
    }
    return [...out];
  });

  readonly canPublish = computed(() => this.emailVerified() && this.phoneVerified());

  async ngOnInit(): Promise<void> {
    await this.loadProfile();
  }

  async loadProfile(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.api.get<WorkerProfileStatusResponse>('/v1/worker/profile');
      this.emailVerified.set(Boolean(res.verificado?.email));
      this.phoneVerified.set(Boolean(res.verificado?.telefono));

      if (res.perfil) {
        this.hasExistingProfile.set(true);
        this.applyProfile(res.perfil);
      } else {
        this.hasExistingProfile.set(false);
      }
    } catch (err) {
      if (err instanceof OrquestaApiError && err.status === 404) {
        this.hasExistingProfile.set(false);
      } else {
        this.error.set(
          err instanceof OrquestaApiError ? err.message : 'Error cargando perfil.',
        );
      }
    } finally {
      this.loading.set(false);
    }
  }

  onTipoChange(nextTipo: WorkerTipo): void {
    this.tipo.set(nextTipo);
    if (nextTipo === 'persona') {
      this.plazasOfrecidas.set(1);
    }
  }

  toggleCategory(cat: string): void {
    const curr = this.categorias();
    if (curr.includes(cat)) {
      if (curr.length === 1) return;
      const next = curr.filter((c) => c !== cat);
      this.categorias.set(next);
      const allowedServices = new Set(next.flatMap((c) => SERVICES_BY_CATEGORY[c] ?? []));
      this.servicios.set(this.servicios().filter((s) => allowedServices.has(s)));
    } else if (curr.length < 3) {
      this.categorias.set([...curr, cat]);
    }
  }

  toggleService(srv: string): void {
    const curr = this.servicios();
    if (curr.includes(srv)) {
      this.servicios.set(curr.filter((s) => s !== srv));
    } else {
      this.servicios.set([...curr, srv]);
    }
  }

  toggleZone(zona: string): void {
    const curr = this.zonas();
    if (curr.includes(zona)) {
      if (curr.length === 1) return;
      this.zonas.set(curr.filter((z) => z !== zona));
    } else if (curr.length < 5) {
      this.zonas.set([...curr, zona]);
    }
  }

  toggleLanguage(lang: string): void {
    const curr = this.idiomas();
    if (curr.includes(lang)) {
      this.idiomas.set(curr.filter((l) => l !== lang));
    } else {
      this.idiomas.set([...curr, lang]);
    }
  }

  async saveProfile(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    this.success.set(null);

    const fotos = this.fotosText()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);
    const referencias = this.referenciasText()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);

    const plazas = this.tipo() === 'persona' ? 1 : Math.min(50, Math.max(1, Number(this.plazasOfrecidas()) || 1));

    const payload: Record<string, unknown> = {
      tipo: this.tipo(),
      nombre_publico: this.nombrePublico().trim(),
      plazas_ofrecidas: plazas,
      categorias: this.categorias(),
      servicios: this.servicios(),
      tarifa: {
        modo: 'fijo',
        monto: Number(this.tarifaMonto()),
        moneda: this.tarifaMoneda().trim().toUpperCase() || 'MXN',
        unidad: this.tarifaUnidad(),
      },
      zonas: this.zonas(),
      radio_km: this.radioKm() ? Number(this.radioKm()) : null,
      idiomas: this.idiomas(),
      años_experiencia: Number(this.aniosExperiencia()) || 0,
      fotos,
      referencias,
    };

    if (this.telefonoE164().trim()) {
      payload['telefono_e164'] = this.telefonoE164().trim();
    }

    try {
      if (this.hasExistingProfile()) {
        const res = await this.api.patch<{ perfil: WorkerProfileDto }>('/v1/worker/profile', payload);
        if (res.perfil) this.applyProfile(res.perfil);
        this.success.set('Cambios guardados.');
      } else {
        await this.api.post<{ worker_id: string; estado: WorkerProfileEstado }>(
          '/v1/worker/profile',
          payload,
        );
        this.hasExistingProfile.set(true);
        this.success.set('Perfil creado. Verifica tu correo y tu teléfono para poder publicarlo.');
        await this.loadProfile();
      }
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error guardando perfil.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  async requestVerification(canal: 'email' | 'telefono'): Promise<void> {
    this.error.set(null);
    this.success.set(null);
    try {
      const res = await this.api.post<{ desafio_id: string; expira_en: string }>(
        '/v1/worker/profile/verifications',
        { canal },
      );
      if (canal === 'email') {
        this.emailDesafioId.set(res.desafio_id);
        this.success.set('Te enviamos un código a tu correo.');
      } else {
        this.phoneDesafioId.set(res.desafio_id);
        this.success.set('Te enviamos un código por SMS.');
      }
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError
          ? err.message
          : 'No se pudo iniciar la verificación.',
      );
    }
  }

  async confirmVerification(canal: 'email' | 'telefono'): Promise<void> {
    const desafioId = canal === 'email' ? this.emailDesafioId() : this.phoneDesafioId();
    const codigoOtp = (canal === 'email' ? this.emailOtp() : this.phoneOtp()).trim();
    if (!desafioId || !codigoOtp) return;

    this.error.set(null);
    this.success.set(null);
    try {
      const res = await this.api.post<{ verificado: boolean; visible_en_busqueda: boolean }>(
        `/v1/worker/profile/verifications/${encodeURIComponent(desafioId)}/confirm`,
        { codigo_otp: codigoOtp },
      );
      if (canal === 'email') {
        this.emailVerified.set(res.verificado);
        this.emailDesafioId.set(null);
        this.emailOtp.set('');
      } else {
        this.phoneVerified.set(res.verificado);
        this.phoneDesafioId.set(null);
        this.phoneOtp.set('');
      }
      this.success.set(
        (canal === 'email' ? 'Correo verificado.' : 'Teléfono verificado.') +
          (res.visible_en_busqueda ? ' Ya apareces en las búsquedas.' : ''),
      );
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Ese código no es correcto o ya venció.',
      );
    }
  }

  async publishProfile(): Promise<void> {
    this.error.set(null);
    this.success.set(null);
    try {
      const res = await this.api.post<{ estado: WorkerProfileEstado }>(
        '/v1/worker/profile/publish',
        {},
      );
      this.estado.set(res.estado);
      this.success.set('Perfil publicado. Las planners te verán en los horarios que marques como disponibles.');
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError
          ? err.message
          : 'No se pudo publicar el perfil.',
      );
    }
  }

  async suspendProfile(): Promise<void> {
    this.error.set(null);
    this.success.set(null);
    try {
      const res = await this.api.post<{ estado: WorkerProfileEstado }>(
        '/v1/worker/profile/suspend',
        {},
      );
      this.estado.set(res.estado);
      this.success.set('Perfil pausado. Ya no apareces en las búsquedas.');
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error al suspender.',
      );
    }
  }

  private applyProfile(p: WorkerProfileDto): void {
    this.tipo.set(p.tipo ?? 'persona');
    this.plazasOfrecidas.set(p.plazas_ofrecidas ?? 1);
    this.nombrePublico.set(p.nombre_publico ?? '');
    this.categorias.set(p.categorias?.length ? p.categorias : ['mesero']);
    this.servicios.set(p.servicios ?? []);
    if (p.tarifa) {
      this.tarifaMonto.set(p.tarifa.monto);
      this.tarifaMoneda.set(p.tarifa.moneda);
      this.tarifaUnidad.set(p.tarifa.unidad);
    }
    this.zonas.set(p.zonas?.length ? p.zonas : ['sur']);
    this.radioKm.set(p.radio_km ?? null);
    this.idiomas.set(p.idiomas ?? []);
    this.aniosExperiencia.set(p.años_experiencia ?? p.anios_experiencia ?? 0);
    this.telefonoE164.set(p.telefono_e164 ?? '');
    this.fotosText.set((p.fotos ?? []).join('\n'));
    this.referenciasText.set((p.referencias ?? []).join('\n'));
    this.estado.set(p.estado ?? 'borrador');
    this.eventosCompletados.set(p.eventos_completados ?? 0);
  }
}
