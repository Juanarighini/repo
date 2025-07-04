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

// Cargar estado riego desde Google Sheets (celda A5)
async function cargarEstado() {
  try {
    const sheets = await getSheets();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A5`,
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
      range: `${SHEET_NAME}!A5`,
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


//Detectar estación actual y rango de celdas
function obtenerEstacionYRango() {
  const now = moment().tz("America/Argentina/Buenos_Aires");
  const month = now.month(); // 0 = enero, ..., 11 = diciembre
  const day = now.date();

  if ((month === 11 && day >= 21) || [0, 1].includes(month) || (month === 2 && day <= 20)) {
    return { estacion: "verano", rango: "A1:H4" };
  } else if ((month === 2 && day >= 21) || [3, 4].includes(month) || (month === 5 && day <= 20)) {
    return { estacion: "otoño", rango: "A5:H8" };
  } else if ((month === 5 && day >= 21) || [6, 7].includes(month) || (month === 8 && day <= 20)) {
    return { estacion: "invierno", rango: "A9:H12" };
  } else {
    return { estacion: "primavera", rango: "A13:H16" };
  }
}

//Endpoint para obtener programación de riego según estación
app.get("/programacion-riego", async (req, res) => {
  try {
    // Obtener día de la semana (0=domingo, 1=lunes, ..., 6=sábado)
    const diaSemana = new Date().getDay();

    // Mapeo para columnas B=1, C=2 ... H=7 para lunes a domingo
    // Pero JavaScript domingo=0 y en hoja domingo está en H (col 7)
    let colIndex;
    if (diaSemana === 0) colIndex = 7; // domingo = H
    else colIndex = diaSemana;          // lunes=1=B, martes=2=C, etc.

    // Detectar estación para definir rango
    const mes = new Date().getMonth() + 1; // Enero=1 ... Diciembre=12
    const dia = new Date().getDate();

    let rango;

    if ((mes === 12 && dia >= 21) || mes === 1 || mes === 2 || (mes === 3 && dia <= 20)) {
      // Verano
      rango = "hoja1!B3:H4";
    } else if ((mes === 3 && dia >= 21) || mes === 4 || (mes === 5 && dia <= 20)) {
      // Otoño
      rango = "hoja1!B7:H8";
    } else if ((mes === 5 && dia >= 21) || mes === 6 || mes === 7 || mes === 8 || (mes === 9 && dia <= 20)) {
      // Invierno
      rango = "hoja1!B11:H12";
    } else {
      // Primavera
      rango = "hoja1!B15:H16";
    }

    const sheets = await getSheets();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: "1KXmQgN2oS-ewSkBJMSHYz5nPQH3R56jScuJ8Vhye4bkD",
      range: rango,
    });

    const values = response.data.values || [];

    if (values.length < 2) {
      return res.status(400).json({ error: "Datos insuficientes en la hoja" });
    }

    // values[0] = fila de días (1 o 0)
    // values[1] = fila de horas (ej: "07:00")

    const dia_riego = values[0][colIndex - 1] || "0";  // colIndex-1 porque el rango empieza en B (col 1)
    const hora_riego = values[1][colIndex - 1] || "";

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
