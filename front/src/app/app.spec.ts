import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes)],
    }).compileComponents();
  });

  it('should create the root shell', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should configure lazy routes for all four surfaces', () => {
    const paths = routes.map((r) => r.path);
    expect(paths).toContain('planner');
    expect(paths).toContain('worker');
    expect(paths).toContain('invitacion');
    expect(paths).toContain('scan');
  });
});
