import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

export const DEFAULT_TITLE = 'Orquesta · Dirige todos tus eventos desde un solo lugar';

/**
 * Título de la pestaña: "<título de la ruta> · Orquesta". Sin esta estrategia, Angular solo cambia
 * el título en las rutas que lo declaran y lo deja igual en las demás: después de visitar
 * Proveedores, todas las páginas del planner decían "Proveedores · Orquesta".
 */
@Injectable({ providedIn: 'root' })
export class OrquestaTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const routeTitle = this.buildTitle(snapshot);
    this.title.setTitle(routeTitle ? `${routeTitle} · Orquesta` : DEFAULT_TITLE);
  }
}
