import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, isDevMode, provideBrowserGlobalErrorListeners } from '@angular/core';
import { TitleStrategy, provideRouter } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { apiInterceptor } from './core/api/api.interceptor';
import { OrquestaTitleStrategy } from './core/title/orquesta-title.strategy';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    { provide: TitleStrategy, useClass: OrquestaTitleStrategy },
    provideHttpClient(withInterceptors([apiInterceptor])),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
