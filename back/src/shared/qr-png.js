import QRCode from "qrcode";

/**
 * PNG del QR de check-in. Un solo lugar para las opciones de render.
 *
 * `filterType: 4` (Paeth fijo): por defecto pngjs prueba los 5 filtros PNG en cada fila y elige el
 * mejor, lo que representaba ~60 % del CPU de un import. Con Paeth fijo el PNG cuesta ~2.6 ms en
 * lugar de ~5 ms y pesa prácticamente lo mismo (≈6.4 KB vs 6.2 KB), así que no penaliza el LCP de
 * la invitación. Medición: back/load/README.md.
 */
export function renderQrPng(token) {
  return QRCode.toBuffer(token, { type: "png", errorCorrectionLevel: "M", rendererOpts: { filterType: 4 } });
}
