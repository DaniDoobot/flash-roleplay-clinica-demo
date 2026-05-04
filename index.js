import 'dotenv/config';
import { instruccionesSistema } from './prompt.js';

import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import twilio from 'twilio';
import pkg from 'wavefile';

const { WaveFile } = pkg;

const {
  GEMINI_API_KEY,
  GEMINI_MODEL = 'models/gemini-3.1-flash-live-preview',
  PORT = 8080,

  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,

  // Host público. En local será la URL de ngrok.
  // En Cloud Run será la URL del servicio desplegado.
  PUBLIC_HOST = 'https://pendiente.run.app',
} = process.env;

if (!GEMINI_API_KEY) {
  console.error('❌ Falta GEMINI_API_KEY en .env');
  process.exit(1);
}

function makeAbsUrl(pathname = '/') {
  const host = (PUBLIC_HOST || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `https://${host}${p}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Convierte audio de Twilio:
 * - Entrada Twilio: μ-law 8kHz en base64
 * - Salida Gemini: PCM lineal 16kHz en base64
 */
function decodeTwilioToGemini(base64Payload) {
  try {
    const twilioMuLawBuffer = Buffer.from(base64Payload, 'base64');

    const muLawArray = new Uint8Array(
      twilioMuLawBuffer.buffer,
      twilioMuLawBuffer.byteOffset,
      twilioMuLawBuffer.byteLength
    );

    const wav = new WaveFile();
    wav.fromScratch(1, 8000, '8m', muLawArray);
    wav.fromMuLaw();
    wav.toSampleRate(16000);
    wav.toBitDepth('16');

    return Buffer.from(wav.data.samples.buffer).toString('base64');
  } catch (err) {
    console.error('🛑 Error decodificando audio Twilio → Gemini:', err);
    return null;
  }
}

/**
 * Convierte audio de Gemini:
 * - Entrada Gemini: PCM 24kHz en base64
 * - Salida Twilio: μ-law 8kHz en base64
 */
function encodeGeminiToTwilio(base64PcmData) {
  try {
    const pcmBuffer = Buffer.from(base64PcmData, 'base64');

    const int16Array = new Int16Array(
      pcmBuffer.buffer,
      pcmBuffer.byteOffset,
      pcmBuffer.byteLength / 2
    );

    const wav = new WaveFile();
    wav.fromScratch(1, 24000, '16', int16Array);
    wav.toSampleRate(8000);
    wav.toMuLaw();

    return Buffer.from(wav.data.samples).toString('base64');
  } catch (err) {
    console.error('🛑 Error codificando audio Gemini → Twilio:', err);
    return null;
  }
}

/**
 * Cliente Twilio REST.
 * Lo usamos para grabar y colgar llamadas.
 */
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

const callInfo = new Map();
const requestedHangupFor = new Set();
const activeRecordingSid = new Map();
const callTimes = new Map();

async function startRecording(callSid) {
  if (!twilioClient) return { ok: false, error: 'no_twilio_credentials' };
  if (!callSid) return { ok: false, error: 'no_call_sid' };

  try {
    const rec = await twilioClient.calls(callSid).recordings.create({
      recordingTrack: 'both',
      recordingStatusCallback: makeAbsUrl('/recording-status'),
      recordingStatusCallbackEvent: ['in-progress', 'completed', 'absent'],
    });

    activeRecordingSid.set(callSid, rec.sid);

    console.log('🎙️ Grabación iniciada:', {
      recordingSid: rec.sid,
      callSid,
    });

    return { ok: true, sid: rec.sid };
  } catch (e) {
    console.error('🛑 Error iniciando grabación:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

async function hangUpCall(callSid, reason = 'fin_de_prueba') {
  if (!twilioClient) return { ok: false, error: 'no_twilio_credentials' };
  if (!callSid) return { ok: false, error: 'no_call_sid' };

  if (requestedHangupFor.has(callSid)) {
    return { ok: true, note: 'already_hanging' };
  }

  try {
    console.log(`☎️ Ejecutando hangUpCall(callSid=${callSid}, reason=${reason})`);

    requestedHangupFor.add(callSid);

    /**
     * Damos unos segundos para que el usuario escuche
     * “La prueba ha terminado. Gracias por participar.”
     */
    await sleep(3000);

    await twilioClient.calls(callSid).update({ status: 'completed' });

    console.log(`📞✅ Llamada colgada. Motivo=${reason}`);

    return { ok: true, callSid, reason };
  } catch (e) {
    requestedHangupFor.delete(callSid);
    console.error('🛑 Error colgando llamada:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Express
 */
const app = express();

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).send('ok');
});

app.get('/', (_req, res) => {
  res.status(200).send('OK. POST /voice | WS /media-stream');
});

/**
 * Endpoint que Twilio llama cuando entra una llamada.
 */
app.all('/voice', async (req, res) => {
  try {
    const hostHeader =
      req.headers['x-forwarded-host'] ||
      req.headers['host'] ||
      `localhost:${PORT}`;

    const baseHost = PUBLIC_HOST
      ? PUBLIC_HOST.replace(/^https?:\/\//, '').replace(/\/+$/, '')
      : hostHeader;

    const wsUrl = `wss://${baseHost}/media-stream`;

    const callSid = req.body?.CallSid || req.query?.CallSid || null;
    const fromNumber = req.body?.From || req.query?.From || '';
    const toNumber = req.body?.To || req.query?.To || '';

    if (callSid) {
      callInfo.set(callSid, {
        from: fromNumber,
        to: toNumber,
      });

      console.log(`👤 Llamante: ${fromNumber} → ${toNumber} | callSid=${callSid}`);
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

    res.set('Content-Type', 'text/xml').status(200).send(twiml);
  } catch (e) {
    console.error('🛑 Error en /voice:', e?.message || e);

    res
      .set('Content-Type', 'text/xml')
      .status(500)
      .send('<Response><Say>Error en la app</Say></Response>');
  }
});

/**
 * Callback de estado de grabación de Twilio.
 * De momento solo respondemos OK.
 */
app.post('/recording-status', async (req, res) => {
  console.log('🎙️ Recording status:', req.body || {});
  res.status(200).send('ok');
});

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  path: '/media-stream',
});

/**
 * Gemini Live API
 */
function connectGeminiRealtime() {
  const url =
    `wss://generativelanguage.googleapis.com/ws/` +
    `google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent` +
    `?key=${GEMINI_API_KEY}`;

  return new WebSocket(url);
}

function sendTwilioAudio(twilioWs, streamSid, base64Payload) {
  if (!streamSid) return;
  if (twilioWs.readyState !== WebSocket.OPEN) return;

  twilioWs.send(
    JSON.stringify({
      event: 'media',
      streamSid,
      media: {
        payload: base64Payload,
      },
    })
  );
}

wss.on('connection', (twilioWs, req) => {
  console.log('📞 Twilio WS conectado desde', req.socket.remoteAddress);

  const geminiWs = connectGeminiRealtime();

  let streamSid = null;
  let callSid = null;
  let geminiReady = false;

  const safeSendToGemini = (obj) => {
    if (geminiWs.readyState !== WebSocket.OPEN) {
      return false;
    }

    geminiWs.send(JSON.stringify(obj));
    return true;
  };

  geminiWs.on('open', () => {
    console.log('✅ Gemini Live conectado');

    const setupMsg = {
      setup: {
        model: GEMINI_MODEL,

        generationConfig: {
          responseModalities: ['AUDIO'],

          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                /**
                 * Voz fija para la simulación.
                 * Puedes cambiarla después si quieres probar otras.
                 */
                voiceName: 'Iapetus',
              },
            },
          },

          thinkingConfig: {
            thinkingLevel: 'minimal',
          },
        },

        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
            endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
            prefixPaddingMs: 120,
            silenceDurationMs: 130,
          },

          turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
          activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
        },

        systemInstruction: {
          parts: [
            {
              text: instruccionesSistema.trim(),
            },
          ],
        },

        tools: [
          {
            functionDeclarations: [
              {
                name: 'hangup_call',
                description:
                  'Cuelga la llamada de forma segura cuando la prueba de roleplay haya terminado.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    reason: {
                      type: 'STRING',
                      description: 'Motivo por el que se finaliza la llamada.',
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    };

    safeSendToGemini(setupMsg);
  });

  twilioWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.event === 'start') {
        const start = msg.start || {};

        streamSid = start.streamSid;
        callSid = start.callSid || callSid || null;

        console.log('🔗 streamSid:', streamSid, '| callSid:', callSid);

        if (callSid && !callTimes.has(callSid)) {
          callTimes.set(callSid, {
            startedAt: new Date(),
          });
        }

        if (callSid) {
          startRecording(callSid).catch(() => {});
        }

        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        if (!geminiReady) return;

        const decodedPcm = decodeTwilioToGemini(msg.media.payload);

        if (decodedPcm) {
          safeSendToGemini({
            realtimeInput: {
              audio: {
                mimeType: 'audio/pcm;rate=16000',
                data: decodedPcm,
              },
            },
          });
        }

        return;
      }

      if (msg.event === 'stop') {
        console.log('⏹️ Twilio stop');

        if (callSid) {
          const now = new Date();
          const info = callTimes.get(callSid) || {};
          const startedAt = info.startedAt || now;
          const durationSeconds = Math.max(
            0,
            Math.round((now - startedAt) / 1000)
          );

          const meta = callInfo.get(callSid) || {};

          console.log('📄 Resumen llamada:', {
            callSid,
            from: meta.from || '',
            to: meta.to || '',
            startIso: startedAt.toISOString(),
            endIso: now.toISOString(),
            durationSeconds,
          });

          callTimes.delete(callSid);
          callInfo.delete(callSid);
          requestedHangupFor.delete(callSid);
          activeRecordingSid.delete(callSid);
        }

        try {
          geminiWs.close();
        } catch {}

        return;
      }
    } catch (e) {
      console.error('🛑 Error procesando mensaje de Twilio:', e?.message || e);
    }
  });

  geminiWs.on('message', async (rawData) => {
    try {
      if (rawData instanceof Buffer) {
        rawData = rawData.toString('utf8');
      }

      let evt;

      try {
        evt = JSON.parse(rawData);
      } catch {
        return;
      }

      /**
       * Setup completado.
       * Aquí inyectamos el primer turno para que el agente empiece
       * directamente con el protocolo de evaluación.
       */
      if (evt.setupComplete) {
        console.log('✅ Gemini setup completado. Iniciando protocolo...');

        geminiReady = true;

        setTimeout(() => {
          safeSendToGemini({
            clientContent: {
              turns: [
                {
                  role: 'user',
                  parts: [
                    {
                      text:
                        'Ha comenzado la llamada. Inicia exactamente el protocolo de evaluación desde el principio.',
                    },
                  ],
                },
              ],
              turnComplete: true,
            },
          });
        }, 800);

        return;
      }

      /**
       * Tool calls de Gemini.
       * En este proyecto solo dejamos hangup_call.
       */
      if (evt.toolCall) {
        const calls = evt.toolCall.functionCalls || [];

        for (const call of calls) {
          const callId = call.id;
          const toolName = call.name;
          const args = call.args || {};

          let result = {};

          if (toolName === 'hangup_call') {
            result = await hangUpCall(callSid, args.reason || 'fin_de_prueba');

            safeSendToGemini({
              toolResponse: {
                functionResponses: [
                  {
                    id: callId,
                    name: toolName,
                    response: {
                      result,
                    },
                  },
                ],
              },
            });
          }
        }

        return;
      }

      /**
       * Contenido generado por Gemini.
       */
      if (evt.serverContent) {
        /**
         * Barge-in:
         * si el usuario empieza a hablar, cortamos el audio del bot en Twilio.
         */
        if (evt.serverContent.interrupted) {
          console.log('🤫 Usuario interrumpe. Cortando audio del bot...');

          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(
              JSON.stringify({
                event: 'clear',
                streamSid,
              })
            );
          }
        }

        /**
         * Audio de respuesta del modelo.
         */
        if (evt.serverContent.modelTurn) {
          const parts = evt.serverContent.modelTurn.parts || [];

          for (const pt of parts) {
            if (pt.inlineData && pt.inlineData.data) {
              const audioData = encodeGeminiToTwilio(pt.inlineData.data);

              if (audioData && streamSid) {
                sendTwilioAudio(twilioWs, streamSid, audioData);
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('🛑 Error procesando mensaje de Gemini:', e?.message || e);
    }
  });

  geminiWs.on('close', (code, reason) => {
    console.log(
      '🔌 Gemini WebSocket cerrado:',
      code,
      reason?.toString() || 'sin motivo'
    );

    try {
      twilioWs.close();
    } catch {}
  });

  geminiWs.on('error', (err) => {
    console.error('🛑 Gemini WebSocket error:', err);
  });

  twilioWs.on('close', () => {
    console.log('🔌 Twilio WebSocket cerrado');

    try {
      geminiWs.close();
    } catch {}
  });

  twilioWs.on('error', (err) => {
    console.error('🛑 Twilio WebSocket error:', err);
  });
});

process.on('unhandledRejection', (reason) => {
  console.error('🛑 UnhandledRejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('🛑 UncaughtException:', error);
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor Gemini Live Roleplay en http://localhost:${PORT}`);
  console.log(`👉 Healthcheck: http://localhost:${PORT}/health`);
  console.log(`👉 Configura Twilio POST: ${PUBLIC_HOST.replace(/\/+$/, '')}/voice`);
});