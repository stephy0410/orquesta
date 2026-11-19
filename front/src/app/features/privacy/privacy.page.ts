import { ChangeDetectionStrategy, Component } from '@angular/core';
import { environment } from '../../../environments/environment';

/**
 * Aviso de privacidad integral (LFPDPPP, README "Seguridad y privacidad").
 *
 * Los datos de identidad del responsable (razón social, domicilio y correo de contacto) viven en
 * `environment.privacy` para completarlos sin tocar el texto. Revisar con asesoría legal antes del
 * lanzamiento.
 */
@Component({
  selector: 'app-privacy-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="oq-container-narrow privacy" id="contenido" tabindex="-1">
      <p><a href="/">← Volver a Orquesta</a></p>
      <h1>Aviso de privacidad integral</h1>
      <p class="oq-hint">Última actualización: {{ privacy.actualizado }}</p>

      <h2>1. Responsable</h2>
      <p>
        {{ privacy.responsable }}, con domicilio en {{ privacy.domicilio }}, es responsable del
        tratamiento de los datos personales que se recaban a través de Orquesta, conforme a la Ley
        Federal de Protección de Datos Personales en Posesión de los Particulares (LFPDPPP).
      </p>

      <h2>2. Datos personales que tratamos</h2>
      <ul>
        <li><strong>Invitados:</strong> nombre, correo electrónico y/o teléfono celular, respuesta de asistencia (RSVP) y registro de entrada al evento.</li>
        <li><strong>Planners:</strong> correo electrónico y contraseña (almacenada solo como hash).</li>
        <li><strong>Proveedores:</strong> nombre público, correo, teléfono, categorías, zonas, tarifa, disponibilidad y datos de las reservas y pagos.</li>
      </ul>
      <p>No tratamos datos personales sensibles. No guardamos datos de tarjetas ni de cuentas bancarias: los pagos los procesa un procesador de pagos certificado.</p>

      <h2>3. Finalidades</h2>
      <p><strong>Primarias</strong> (necesarias para el servicio):</p>
      <ul>
        <li>Enviar invitaciones, recordatorios y avisos del evento por SMS y correo.</li>
        <li>Registrar la confirmación de asistencia y validar la entrada con el código QR.</li>
        <li>Contratar, coordinar y pagar a proveedores del evento.</li>
        <li>Seguridad, prevención de fraude y cumplimiento de obligaciones legales.</li>
      </ul>
      <p><strong>Secundarias:</strong> ninguna. No usamos tus datos con fines publicitarios ni los vendemos.</p>

      <h2>4. Transferencias y encargados</h2>
      <p>
        No transferimos datos a terceros para sus propios fines. Compartimos lo estrictamente necesario
        con encargados que tratan los datos por nuestra cuenta: infraestructura en la nube (Amazon Web
        Services), envío de SMS y correo, y el procesador de pagos. El organizador del evento (planner)
        ve los datos de sus invitados; un proveedor solo ve datos de contacto del evento cuando acepta
        una reserva.
      </p>

      <h2>5. Conservación</h2>
      <ul>
        <li>Los <strong>teléfonos de los invitados se borran 90 días</strong> después del evento.</li>
        <li>El resto de los datos de contacto de invitados y tokens se borran o anonimizan a los 12 meses del cierre del evento.</li>
        <li>Los registros de entrada conservan solo datos agregados sin identificar el dispositivo a los 24 meses.</li>
        <li>Los registros contables de pagos se conservan sin datos personales de contacto.</li>
      </ul>

      <h2>6. Derechos ARCO y revocación del consentimiento</h2>
      <p>
        Puedes ejercer tus derechos de Acceso, Rectificación, Cancelación y Oposición, revocar tu
        consentimiento o limitar el uso de tus datos escribiendo a
        @if (privacy.contacto) {
          <a [href]="'mailto:' + privacy.contacto">{{ privacy.contacto }}</a>,
        } @else {
          el organizador de tu evento, quien canalizará tu solicitud con el responsable,
        }
        indicando tu nombre, el evento y el derecho que quieres ejercer. Responderemos en un máximo
        de 20 días hábiles.
      </p>
      <p>
        Como invitado también puedes dejar de recibir SMS o correos en cualquier momento desde tu
        invitación, en la sección «Mensajes sobre este evento».
      </p>

      <h2>7. Tecnologías de rastreo</h2>
      <p>
        Usamos una cookie de sesión estrictamente necesaria para planners y proveedores, y
        almacenamiento local del navegador para que el escáner funcione sin conexión. No usamos
        cookies publicitarias ni de rastreo de terceros.
      </p>

      <h2>8. Seguridad</h2>
      <p>
        Todo el tráfico va cifrado (TLS) y los datos de contacto se guardan cifrados. El código QR de
        tu invitación no contiene datos personales.
      </p>

      <h2>9. Cambios a este aviso</h2>
      <p>Cualquier cambio se publicará en esta misma página con su fecha de actualización.</p>
    </main>
  `,
  styles: [
    `
      .privacy {
        padding-block: 2rem 4rem;
        line-height: 1.6;
      }
      .privacy h2 {
        font-size: 1.1rem;
        margin-top: 1.75rem;
      }
    `,
  ],
})
export class PrivacyPage {
  readonly privacy = environment.privacy;
}
