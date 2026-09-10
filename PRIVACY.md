# Política de privacidad — fitbit-health-mcp

Esta es una aplicación de uso estrictamente personal, no distribuida ni operada
como servicio para terceros.

- **Qué datos accede**: datos de sueño y métricas de recuperación (HRV, SpO2,
  frecuencia respiratoria, frecuencia cardíaca en reposo) del propio Google
  Health / Fitbit del desarrollador, vía Google Health API, usando su propia
  cuenta de Google como único usuario autorizado.
- **Cómo se almacenan**: el token de acceso (refresh token) se guarda
  localmente en el servidor del desarrollador (`.env`), nunca se comparte con
  terceros ni se sube a control de versiones.
- **Con quién se comparte**: con nadie. Los datos se consultan bajo demanda
  para responder preguntas del propio desarrollador a través de un asistente
  de IA (Claude), y no se almacenan permanentemente ni se envían a ningún otro
  servicio.
- **Retención**: no se conserva copia histórica de los datos fuera de las
  respuestas efímeras generadas en el momento de la consulta.
- **Revocación**: el acceso puede revocarse en cualquier momento desde
  https://myaccount.google.com/permissions.

Contacto: [tu email aquí]
