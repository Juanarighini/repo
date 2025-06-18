const express = require("express");
const axios = require("axios");
const moment = require("moment-timezone");
const fs = require("fs");
const cron = require("node-cron");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 1000;

const API_KEY = process.env.APIKEY;  // Usar JSON.parse(process.env.APIKEY) si guardaste el string con comillas
const BASE_URL = "https://api.tomorrow.io/v4/weather/forecast";

const ubicacion = "-33.4976173,-64.3157374"; // ejemplo San Basilio

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const SPREADSHEET_ID = "16cVvdsQvRXh9lCScY05N4AW0Cs_PwhkSBpUN-CA50LY";
const SHEET_NAME = "test";

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

// Inicialización cliente Google Sheets (para reusar)
const clientPromise = auth.getClient();
let sheets;

async function getSheets() {
  if (!sheets) {
    const client = await clientPromise;
    sheets = google.sheets({ version: "v4", auth: client });
  }
  return sheets;
}

// Leer datos desde hoja (ahora A1:B3)
async function loadRainData() {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:B3`,
    });
    const values = res.data.values || [];

    return {
      rainAccumulation: parseFloat(values[0]?.[1]) || 0,
      lastResetDate: values[1]?.[1] || moment().tz("America/Argentina/Buenos_Aires").format("YYYY-MM-DD"),
      lastAccumulatedTime: values[2]?.[1] || null,
    };
  } catch (error) {
    console.error("Error cargando rainData desde Google Sheets:", error);
    return {
      rainAccumulation: 0,
      lastResetDate: moment().tz("America/Argentina/Buenos_Aires").format("YYYY-MM-DD"),
      lastAccumulatedTime: null,
    };
  }
}

// Guardar datos en hoja (A1:B3)
async function saveRainData(data) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:B3`,
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [
          ["rainAccumulation", data.rainAccumulation],
          ["lastResetDate", data.lastResetDate],
          ["lastAccumulatedTime", data.lastAccumulatedTime || ""],
        ],
      },
    });
  } catch (error) {
    console.error("Error guardando rainData en Google Sheets:", error);
  }
}

// Verificar si es un nuevo día y reiniciar el acumulador si es necesario
async function resetRainAccumulationIfNewDay() {
  const rainData = await loadRainData();
  const currentDate = moment()
    .tz("America/Argentina/Buenos_Aires")
    .format("YYYY-MM-DD");

  if (rainData.lastResetDate !== currentDate) {
    const newData = {
      rainAccumulation: 0,
      lastResetDate: currentDate,
    };
    await saveRainData(newData);
    console.log("📅 Acumulación de lluvia reseteada automáticamente.");
  } else {
    console.log("✔️ Acumulación de lluvia ya reseteada hoy.");
  }
}

// Cron para reset diario a las 00:00
cron.schedule("0 0 * * *", async () => {
  await resetRainAccumulationIfNewDay();
  console.log("⏰ Tarea programada: reset automático ejecutado.");
});


app.get("/weather/all", async (req, res) => {
  try {
    await resetRainAccumulationIfNewDay();
    const rainData = await loadRainData();

    const [minutelyResponse, hourlyResponse] = await Promise.all([
      axios.get(BASE_URL, {
        params: {
          location: ubicacion,
          apikey: API_KEY,
          timesteps: "minutely",
          units: "metric",
        },
      }),
      axios.get(BASE_URL, {
        params: {
          location: ubicacion,
          apikey: API_KEY,
          timesteps: "hourly",
          units: "metric",
        },
      }),
    ]);

    const minutelyData = minutelyResponse.data?.timelines?.minutely || [];
    const firstMinutely = minutelyData[0] || {};

    const hourlyData = hourlyResponse.data?.timelines?.hourly || [];
    const firstHourly = hourlyData[0] || {};

    const newRain = firstHourly.values?.rainAccumulation || 0;
    const newRainTime = firstHourly.time || null;

    // Solo sumar si es un dato más nuevo que el último guardado
    let updatedRainAccumulation = rainData.rainAccumulation;
    if (newRainTime && newRainTime !== rainData.lastAccumulatedTime) {
      updatedRainAccumulation += newRain;
    }

    const updatedData = {
      rainAccumulation: updatedRainAccumulation,
      lastResetDate: rainData.lastResetDate,
      lastAccumulatedTime: newRainTime,
    };

    await saveRainData(updatedData);

    const combinedData = {
      time: moment(firstMinutely.time || firstHourly.time)
        .tz("America/Argentina/Buenos_Aires")
        .format("YYYY-MM-DDTHH:mm:ss"),
      precipitationProbability:
        firstMinutely.values?.precipitationProbability || 0,
      windSpeed: firstMinutely.values?.windSpeed || 0,
      rainAccumulation: newRain,
      weatherCode: firstMinutely.values?.weatherCode || 0,
    };

    res.json(combinedData);
  } catch (error) {
    console.error("Error al obtener los datos:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

app.get("/weather", async (req, res) => {
  try {
    await resetRainAccumulationIfNewDay();
    const rainData = await loadRainData();

    const currentMinute = moment().minute();
    const timesteps = currentMinute === 8 ? "hourly" : "minutely";

    const response = await axios.get(BASE_URL, {
      params: {
        location: ubicacion,
        apikey: API_KEY,
        timesteps: timesteps,
        units: "metric",
      },
    });

    if (timesteps === "hourly") {
      const intervals = response.data.timelines.hourly;

      // Solo sumamos acumulado nuevo si el tiempo es más reciente que el guardado
      let totalNewRain = 0;
      let latestTime = rainData.lastAccumulatedTime;

      for (const interval of intervals) {
        if (!rainData.lastAccumulatedTime || interval.time > rainData.lastAccumulatedTime) {
          totalNewRain += interval.values.rainAccumulation || 0;
          if (!latestTime || interval.time > latestTime) latestTime = interval.time;
        }
      }

      const updatedData = {
        rainAccumulation: rainData.rainAccumulation + totalNewRain,
        lastResetDate: rainData.lastResetDate,
        lastAccumulatedTime: latestTime,
      };

      await saveRainData(updatedData);

      const data = intervals.map((interval) => ({
        time: moment(interval.time)
          .tz("America/Argentina/Buenos_Aires")
          .format("YYYY-MM-DDTHH:mm:ss"),
        rainAccumulation: interval.values.rainAccumulation || 0,
      }));

      res.json(data.slice(0, 6));
    } else {
      const data = response.data.timelines.minutely.map((interval) => ({
        time: moment(interval.time)
          .tz("America/Argentina/Buenos_Aires")
          .format("YYYY-MM-DDTHH:mm:ss"),
        precipitationProbability:
          interval.values.precipitationProbability || 0,
        windSpeed: interval.values.windSpeed || 0,
        weatherCode: interval.values.weatherCode || 0,
        rainAccumulation: interval.values.rainAccumulation || 0,
      }));

      res.json(data.slice(0, 10));
    }
  } catch (error) {
    console.error("Error al consultar la API:", {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
    });
    res.status(500).send("Error al obtener datos del clima");
  }
});

const ntpClient = require("ntp-client");

// Endpoint para hora NTP
app.get("/time", (req, res) => {
  ntpClient.getNetworkTime("2.ar.pool.ntp.org", 123, (err, date) => {
    if (err) {
      console.error("Error al obtener la hora NTP:", err);
      return res.status(500).send("Error al obtener la hora");
    }

    // Ajustar a UTC-3 (Argentina)
    const argentinaTime = new Date(date.getTime() - 3 * 60 * 60 * 1000);
    const formattedArgentinaTime = argentinaTime.toISOString();

    res.json({ time: formattedArgentinaTime });
  });
});

// Helper para obtener sheets cliente
async function getSheets() {
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

// Cargar estado riego desde Google Sheets (celda B4)
async function cargarEstado() {
  try {
    const sheets = await getSheets();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!B4`,
    });

    const rows = response.data.values;
    if (rows && rows.length > 0 && rows[0][0] !== undefined) {
      const estado = parseInt(rows[0][0], 10);
      if ([0, 1, 2, 3, 4].includes(estado)) {
        return estado;
      }
    }
  } catch (error) {
    console.error("Error al cargar el estado desde Google Sheets:", error);
  }
  return 0;
}

// Cargar estado riego desde Google Sheets (celda B4)
async function cargarEstado() {
  try {
    const sheets = await getSheets();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!B4`,
    });

    const rows = response.data.values;
    if (rows && rows.length > 0 && rows[0][0] !== undefined) {
      const estado = parseInt(rows[0][0], 10);
      if ([0, 1, 2, 3, 4].includes(estado)) {
        return estado;
      }
    }
  } catch (error) {
    console.error("Error al cargar el estado desde Google Sheets:", error);
  }
  return 0;
}

// Endpoint para obtener estadoRiego
app.get("/getRiegoEstado", async (req, res) => {
  try {
    const estado = await cargarEstado();
    res.json({ estado_riego: estado });
  } catch (error) {
    console.error("Error leyendo estado de riego:", error);
    res.status(500).json({ error: "Error leyendo estado de riego" });
  }
});

// Endpoint para modificar estadoRiego (0 a 4)
app.get("/setRiegoEstado", async (req, res) => {
  try {
    const nuevoEstado = parseInt(req.query.riego_estado, 10);
    if (![0, 1, 2, 3, 4].includes(nuevoEstado)) {
      return res.status(400).json({ error: "Estado inválido" });
    }
    await guardarEstado(nuevoEstado);
    res.json({ message: "Estado del riego actualizado correctamente." });
  } catch (error) {
    console.error("Error actualizando estado de riego:", error);
    res.status(500).json({ error: "Error actualizando estado de riego" });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});

