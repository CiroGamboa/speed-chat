# Alarm sound — what breaks, and what to do about it

Written after several events where the rotation alarm showed on screen but made no sound,
and the team's only workaround was to disconnect and reconnect the Bluetooth speaker.

## What was actually wrong

The browser will not let a page make a sound until somebody has clicked on that page.

The venue PC entered the Speed Chat password once, months ago, and the app remembers that
in `localStorage` — so the password box never appears again. If nobody clicks the screen
after opening it, the page runs all night **without ever being allowed to play audio**. The
rotation banner still appeared on time, because drawing on screen needs no permission. The
alarm was simply never allowed to sound.

Reconnecting the Bluetooth speaker "fixed" it because walking to the PC and clicking around
the Chrome window is itself the click the browser was waiting for. The dongle got the credit;
the click did the work.

The app now says so out loud: a red **"ALARM SOUND IS NOT ENABLED — CLICK HERE"** banner
across the top of the screen whenever it has not been allowed to play sound.

## Before doors open — 60 seconds

1. Open the page on the venue PC.
2. If the red banner is at the top, **click it**. It must disappear.
3. Press **Test sound** next to the Alarm switch. Answer **Yes, I heard it** only if the
   speaker really made a noise.
4. The small badge beside the Alarm switch should now read **"Alarm armed · heard HH:MM"**.
5. Leave a phone open on the same page in viewer mode next to the speaker, as a backup
   ringer. It is a completely separate machine, so it fails for completely separate reasons.

Re-run steps 3-4 after anything changes about the speaker — re-pairing it, switching output
device, waking the laptop, or reloading the page.

## If there is still no sound

Work down this list. The first four are things no software can detect or fix.

| Check | Why |
|---|---|
| Is Windows actually playing to the speaker? | When Bluetooth drops, Windows silently falls back to the monitor's HDMI output or the headphone jack. Chrome plays perfectly — into a device nobody can hear. |
| Open **Volume Mixer** and find Chrome's slider on the Bluetooth device | Windows keeps a separate volume per app *per output device*. Chrome's can sit at zero or muted. Re-pairing creates a fresh session at full volume, which is why re-pairing seemed to help. |
| Is the speaker's own volume up, and is it not muted? | Obvious, and still the cause sometimes. |
| Does the speaker auto-standby? | Many cheap Bluetooth speakers power down their amplifier after a few minutes of quiet and take 1-3 seconds to wake, which eats the start of the alarm. Disable auto-standby if the speaker offers it. |
| Windows power plan set to never sleep? | A sleeping PC drops Bluetooth and stops the timers. |
| Is the badge red, saying **"Alarm pipeline FAILED"**? | That means the app tried every route to the speaker and all of them failed. Reload the page, then re-run the sound check. |

**The single best fix is a wired or USB speaker.** It removes Bluetooth standby, A2DP
restarts and the device-switching problems in one move.

## If it happens again, capture the evidence

Open the gear icon → **Download alarm diagnostics**. That file records every alarm, which
route the sound took, every output-device change, and whether the page was allowed to play
audio at all. It survives a page reload. Send it on — it will say exactly what happened
instead of leaving us guessing.

## What the app can and cannot tell you

It **can** tell you that it has not been allowed to play sound, that a clip failed to start
or stalled, and that the output device changed.

It **cannot** tell you whether any noise actually reached the room. Nothing running in a
browser can see the Windows volume mixer, which speaker the audio landed on, or whether the
speaker is awake. That is why the badge never claims "sound OK" on its own, and why the
**Test sound → did you hear it?** question exists. Your ear is the only real check.

---

# Sonido de la alarma — guía rápida (español)

## Qué pasaba

El navegador no deja que una página haga sonido hasta que alguien hace clic en ella.

El PC del evento ya había puesto la contraseña hace meses, así que la ventana de contraseña
ya no vuelve a aparecer. Si nadie hace clic en la pantalla, la página funciona toda la noche
**sin permiso para reproducir audio**. El aviso de cambio de puesto sí aparecía en pantalla,
porque dibujar no necesita permiso. El sonido nunca estuvo autorizado.

Desconectar y reconectar el Bluetooth "lo arreglaba" porque ir al PC y hacer clic en la
ventana de Chrome **es** el clic que el navegador estaba esperando. El mérito se lo llevó el
Bluetooth; el trabajo lo hizo el clic.

Ahora la aplicación lo avisa: una franja roja arriba que dice
**"ALARM SOUND IS NOT ENABLED — CLICK HERE"** siempre que no tenga permiso para sonar.

## Antes de abrir las puertas — 60 segundos

1. Abre la página en el PC del evento.
2. Si aparece la franja roja arriba, **haz clic en ella**. Tiene que desaparecer.
3. Pulsa **Test sound** al lado del interruptor "Alarm". Responde **Yes, I heard it** solo si
   el parlante sonó de verdad.
4. La etiqueta junto al interruptor debe decir **"Alarm armed · heard HH:MM"**.
5. Deja un celular abierto en la misma página, en modo viewer, al lado del parlante, como
   alarma de respaldo. Es otro equipo distinto, así que falla por motivos distintos.

Repite los pasos 3 y 4 cada vez que cambie algo del parlante: volver a emparejarlo, cambiar
de salida de audio, despertar el portátil o recargar la página.

## Si sigue sin sonar

1. Revisa que Windows esté reproduciendo **en el parlante** y no en el HDMI del monitor o en
   la salida de audífonos. Cuando el Bluetooth se cae, Windows cambia de salida sin avisar.
2. Abre el **Mezclador de volumen** de Windows y busca el control de Chrome **en el
   dispositivo Bluetooth**. Windows guarda un volumen distinto por aplicación y por salida;
   el de Chrome puede estar en cero o silenciado.
3. Sube el volumen del parlante y comprueba que no esté en mute.
4. Desactiva el apagado automático del parlante si tiene esa opción: muchos se duermen tras
   unos minutos en silencio y tardan 1 a 3 segundos en despertar, y se comen el inicio de la
   alarma.
5. Configura Windows para que **nunca** se suspenda.
6. Si la etiqueta está en rojo con **"Alarm pipeline FAILED"**, recarga la página y vuelve a
   hacer la prueba de sonido.

**Lo que mejor funciona es un parlante por cable o USB.** Elimina de golpe el modo reposo del
Bluetooth, los reinicios de la conexión y los cambios de dispositivo.

## Si vuelve a pasar, guarda la evidencia

Abre el engranaje → **Download alarm diagnostics** y envía ese archivo. Registra cada alarma,
por qué ruta salió el sonido, cada cambio de dispositivo de audio y si la página tenía permiso
para sonar. Sobrevive a una recarga de la página.

## Lo que la aplicación no puede saber

Puede avisarte de que no tiene permiso para sonar, de que un sonido no arrancó o se quedó
colgado, y de que cambió el dispositivo de salida.

**No** puede saber si el sonido llegó realmente a la sala. Ningún programa dentro del
navegador ve el mezclador de volumen de Windows, ni a qué parlante fue el audio, ni si el
parlante está despierto. Por eso la etiqueta nunca dice sola "el sonido está bien", y por eso
existe la pregunta **Test sound → ¿lo escuchaste?**. Tu oído es la única comprobación real.
