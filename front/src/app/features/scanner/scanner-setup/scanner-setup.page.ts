import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../core/auth/auth.service';
import { ActiveScanSessionMeta } from '../../../core/auth/auth-token.store';
import { OrquestaApiError } from '../../../core/api/api-config';
import { humanize } from '../../../shared/labels';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { BatchSyncService } from '../../../core/sync/batch-sync.service';
import { ScanStorageService } from '../../../core/storage/scan-storage.service';

@Component({
  selector: 'app-scanner-setup-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './scanner-setup.page.html',
  styleUrl: './scanner-setup.page.scss',
})
export class ScannerSetupPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly sync = inject(BatchSyncService);
  private readonly storage = inject(ScanStorageService);
  readonly label = humanize;
  readonly connectivity = inject(ConnectivityService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly accessTokenInput = signal<string>('');
  readonly eventIdInput = signal<string>('');
  readonly loading = signal<boolean>(false);
  readonly statusMessage = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly existingSession = signal<ActiveScanSessionMeta | null>(null);

  async ngOnInit(): Promise<void> {
    const existing = await this.auth.hydrateScanSession();
    this.existingSession.set(existing);

    const switchMode = this.route.snapshot.queryParamMap.get('switch');
    const tokenParam = this.route.snapshot.queryParamMap.get('token');
    if (tokenParam) {
      // Llegó por el enlace que compartió la planner: abrimos el escáner sin pedir nada más.
      this.accessTokenInput.set(tokenParam);
      await this.activateWithAccessToken();
      return;
    }

    if (existing && !switchMode && !tokenParam) {
      await this.router.navigate(['/scan/terminal']);
    }
  }

  async activateWithAccessToken(): Promise<void> {
    const token = this.accessTokenInput().trim();
    if (!token || this.loading()) return;

    this.loading.set(true);
    this.error.set(null);
    this.statusMessage.set('Revisando tu código de acceso…');

    try {
      await this.auth.redeemEventAccessToken(token);
      this.statusMessage.set('Descargando la lista de invitados…');
      await this.sync.refreshRosterAndRevocations(true);
      await this.router.navigate(['/scan/terminal']);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'No se pudo iniciar la sesión de escaneo.',
      );
      this.statusMessage.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  async activateWithStaffAccount(): Promise<void> {
    const eventId = this.eventIdInput().trim();
    if (!eventId || this.loading()) return;

    this.loading.set(true);
    this.error.set(null);
    this.statusMessage.set('Abriendo el escáner del evento…');

    try {
      await this.auth.openScanSessionFromAccount(eventId);
      this.statusMessage.set('Descargando la lista de invitados…');
      await this.sync.refreshRosterAndRevocations(true);
      await this.router.navigate(['/scan/terminal']);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'No se pudo abrir la sesión de escaneo.',
      );
      this.statusMessage.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  async resumeExisting(): Promise<void> {
    await this.router.navigate(['/scan/terminal']);
  }

  async clearExisting(): Promise<void> {
    await this.auth.closeScanSession();
    this.existingSession.set(null);
  }

  readonly rosterCount = this.storage.rosterCount;
  readonly queueDepth = this.storage.queueDepth;
}
