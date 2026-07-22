const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const POLL_INTERVAL_MS = 60 * 1000;
const MAGNITUD_MINIMA = 3.5;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function idSismo(sismo) {
  return `${sismo.Fecha}_${sismo.RefGeografica}`.replace(/\s+/g, "_");
}

async function obtenerSismos() {
  const { data } = await axios.get(
    "https://api.gael.cloud/general/public/sismos",
    { timeout: 10000 }
  );
  return data;
}

async function enviarPush(tokens, sismo) {
  if (tokens.length === 0) return;

  const mensajes = tokens.map((t) => ({
    to: t,
    sound: "default",
    title: `🌎 Sismo M${sismo.Magnitud}`,
    body: `${sismo.RefGeografica} · Profundidad ${sismo.Profundidad} km`,
    priority: "high",
    channelId: "sismos",
    data: { sismo },
  }));

  const lotes = [];
  for (let i = 0; i < mensajes.length; i += 100) {
    lotes.push(mensajes.slice(i, i + 100));
  }

  for (const lote of lotes) {
    try {
      await axios.post("https://exp.host/--/api/v2/push/send", lote, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 10000,
      });
    } catch (err) {
      console.error("Error enviando lote de push:", err.message);
    }
  }
}

async function revisarSismos() {
  try {
    const sismos = await obtenerSismos();
    if (!Array.isArray(sismos)) return;

    for (const sismo of sismos) {
      const magnitud = parseFloat(sismo.Magnitud);
      if (isNaN(magnitud) || magnitud < MAGNITUD_MINIMA) continue;

      const id = idSismo(sismo);

      const { data: existente } = await supabase
        .from("sismos_notificados")
        .select("id")
        .eq("id", id)
        .maybeSingle();

      if (existente) continue;

      const { data: tokensRows, error: errTokens } = await supabase
        .from("push_tokens")
        .select("token");

      if (errTokens) {
        console.error("Error leyendo tokens:", errTokens.message);
        continue;
      }

      const tokens = (tokensRows || []).map((r) => r.token);

      await enviarPush(tokens, sismo);

      await supabase.from("sismos_notificados").insert({
        id,
        fecha: sismo.Fecha,
        magnitud,
        profundidad: sismo.Profundidad,
        referencia: sismo.RefGeografica,
        notificado_a: tokens.length,
      });

      console.log(
        `Sismo nuevo notificado: M${magnitud} ${sismo.RefGeografica} -> ${tokens.length} celulares`
      );
    }
  } catch (err) {
    console.error("Error en revisarSismos:", err.message);
  }
}

app.post("/register-token", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Falta token" });

  const { error } = await supabase
    .from("push_tokens")
    .upsert({ token }, { onConflict: "token" });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post("/unregister-token", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Falta token" });

  await supabase.from("push_tokens").delete().eq("token", token);
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.json({ status: "ok", servicio: "sismo-alertas-backend" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  revisarSismos();
  setInterval(revisarSismos, POLL_INTERVAL_MS);
});
