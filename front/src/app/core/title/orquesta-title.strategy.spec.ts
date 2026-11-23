import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { Router, TitleStrategy, provideRouter } from '@angular/router';
import { DEFAULT_TITLE, OrquestaTitleStrategy } from './orquesta-title.strategy';

@Component({ template: '' })
class BlankPage {}

describe('OrquestaTitleStrategy', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'proveedores', title: 'Proveedores', component: BlankPage },
          { path: 'events/:id', title: 'Evento', component: BlankPage },
          { path: 'sin-titulo', component: BlankPage },
        ]),
        { provide: TitleStrategy, useClass: OrquestaTitleStrategy },
      ],
    });
  });

  it('pone el título de cada ruta y no arrastra el de la anterior', async () => {
    const router = TestBed.inject(Router);
    const title = TestBed.inject(Title);

    await router.navigateByUrl('/proveedores');
    expect(title.getTitle()).toBe('Proveedores · Orquesta');

    await router.navigateByUrl('/events/01ABC');
    expect(title.getTitle()).toBe('Evento · Orquesta');

    await router.navigateByUrl('/sin-titulo');
    expect(title.getTitle()).toBe(DEFAULT_TITLE);
  });
});
