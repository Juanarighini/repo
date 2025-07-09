const express = require("express");
const axios = require("axios");
const moment = require("moment-timezone");
const fs = require("fs");
const cron = require("node-cron");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 1000;

const API_KEY = process.env.APIKEY; 
const BASE_URL = "https://api.tomorrow.io/v4/weather/forecast";

const ubicacion = "-33.4976173,-64.3157374"; //San Basilio

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

async function resetEstadoRiegoIfNewDay() {
  try {
    const sheets = await getSheets();
    const currentDate = moment().tz("America/Argentina/Buenos_Aires").format("YYYY-MM-DD");

    // Leer la última fecha de reseteo desde B5
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!B5`,
    });

    const lastReset = response.data.values?.[0]?.[0];

    if (lastReset !== currentDate) {
      // Si es un nuevo día, resetear estadoRiego a 0 (en B4)
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!B4`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[0]],
        },
      });

      // Guardar nueva fecha de reseteo en B5
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!B5`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[currentDate]],
        },
      });

      console.log("🕛 estadoRiego reseteado a 0 y fecha actualizada.");
    } else {
      console.log("✔️ estadoRiego ya fue reseteado hoy.");
    }
  } catch (error) {
    console.error("❌ Error al resetear estadoRiego:", error);
  }
}

cron.schedule("0 0 * * *", async () => {
  try {
    await resetRainAccumulationIfNewDay();
    await resetEstadoRiegoIfNewDay();
    console.log("⏰ Reset diario: lluvia y estadoRiego reseteados.");
  } catch (error) {
    console.error("❌ Error durante el reset diario:", error);
  }
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

// Cargar estado riego desde Google Sheets (celda A5)
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

// Guardar estado riego en Google Sheets (celda A5)
async function guardarEstado(nuevoEstado) {
  try {
    if (![0, 1, 2, 3, 4].includes(nuevoEstado)) {
      throw new Error("Estado no válido para guardar");
    }
    const sheets = await getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!B4`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[nuevoEstado]],
      },
    });
  } catch (error) {
    console.error("Error al guardar el estado en Google Sheets:", error);
  }
}

// Endpoint para obtener estado de riego
app.get("/getRiegoEstado", async (req, res) => {
  const estado = await cargarEstado();
  res.json({ estado_riego: estado });
});

// Endpoint para actualizar estado de riego
app.get("/setRiegoEstado", async (req, res) => {
  const estado = parseInt(req.query.riego_estado, 10);

  if ([0, 1, 2, 3, 4].includes(estado)) {
    await guardarEstado(estado);
    res.json({ message: "Estado del riego actualizado correctamente." });
  } else {
    res.status(400).json({ error: "Estado no válido" });
  }
});


app.get("/programacion-riego", async (req, res) => {
  try {
    // Día de la semana actual: 0=Domingo, ..., 6=Sábado
    const diaSemana = new Date().getDay();

    // Mapeo: índice en la fila de la hoja (lunes=B=0, ..., domingo=H=6)
    const mapaColumna = [6, 0, 1, 2, 3, 4, 5];
    const colIndex = mapaColumna[diaSemana];

    // Fecha actual
    const mes = new Date().getMonth() + 1; // Enero=1 ... Diciembre=12
    const dia = new Date().getDate();

    let rango;
    if ((mes === 12 && dia >= 21) || mes === 1 || mes === 2 || (mes === 3 && dia <= 20)) {
      rango = "hoja1!B3:H4"; // Verano
    } else if ((mes === 3 && dia >= 21) || mes === 4 || (mes === 5 && dia <= 20)) {
      rango = "hoja1!B7:H8"; // Otoño
    } else if ((mes === 5 && dia >= 21) || mes === 6 || mes === 7 || mes === 8 || (mes === 9 && dia <= 20)) {
      rango = "hoja1!B11:H12"; // Invierno
    } else {
      rango = "hoja1!B15:H16"; // Primavera
    }

    const sheets = await getSheets();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: "1KXmQgN2oS-ewSkBJMSHYz5nPQH3R56jScuJ8Vhye4bk",
      range: rango,
    });

    const values = response.data.values || [];

    if (values.length < 2) {
      return res.status(400).json({ error: "Datos insuficientes en la hoja" });
    }

    const dia_riego = values[0][colIndex] || "0";  // 1 o 0
    const hora_riego = values[1][colIndex] || "";  // formato "hh:mm"

    res.json({
      dia_riego,
      hora_riego,
    });

  } catch (error) {
    console.error("Error al obtener programación de riego:", error);
    res.status(500).json({ error: "Error al obtener programación de riego" });
  }
});



// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});
