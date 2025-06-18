const express = require("express");
const axios = require("axios");
const moment = require("moment-timezone");
const fs = require("fs");
const cron = require("node-cron"); // Importar node-cron

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "lZY6Z1jCDicjqKVzuePasf6QIDVAJWnt";
const BASE_URL = "https://api.tomorrow.io/v4/weather/forecast";

const a = "-33.4976173,-64.3157374"; // San Basilio
const b = "-33.132108,-64.3497229"; // Río Cuarto
const c = "-32.5280271,-64.5905781"; // RDLS
const ubicacion = a;

const DATA_FILE = "./rainData.json";

// Leer los datos desde un archivo
function loadRainData() {
  if (fs.existsSync(DATA_FILE)) {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return data;
  }
  return {
    rainAccumulation: 0,
    lastResetDate: moment()
      .tz("America/Argentina/Buenos_Aires")
      .format("YYYY-MM-DD"),
  };
}

// Guardar los datos en un archivo
function saveRainData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data), "utf8");
}

let rainData = loadRainData();

// Verificar si es un nuevo día y reiniciar el acumulador si es necesario
function resetRainAccumulationIfNewDay() {
  const currentDate = moment()
    .tz("America/Argentina/Buenos_Aires")
    .format("YYYY-MM-DD");
  if (rainData.lastResetDate !== currentDate) {
    rainData = { rainAccumulation: 0, lastResetDate: currentDate };
    saveRainData(rainData);
    console.log("📅 Acumulación de lluvia reseteada automáticamente.");
  }
}

// 🕛 Programar reseteo diario a las 00:00
cron.schedule("0 0 * * *", () => {
  resetRainAccumulationIfNewDay();
  console.log("⏰ Tarea programada: reset automático ejecutado.");
});

app.get("/weather/all", async (req, res) => {
  try {
    resetRainAccumulationIfNewDay();

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

    const newRainAccumulation = firstHourly.values?.rainAccumulation || 0;
    rainData.rainAccumulation += newRainAccumulation;
    saveRainData(rainData);

    const combinedData = {
      time: moment(firstMinutely.time || firstHourly.time)
        .tz("America/Argentina/Buenos_Aires")
        .format("YYYY-MM-DDTHH:mm:ss"),
      precipitationProbability:
        firstMinutely.values?.precipitationProbability || 0,
      windSpeed: firstMinutely.values?.windSpeed || 0,
      rainAccumulation: newRainAccumulation,
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
    resetRainAccumulationIfNewDay();

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

    const data =
      timesteps === "hourly"
        ? response.data.timelines.hourly.map((interval) => {
            const adjustedTime = moment(interval.time)
              .tz("America/Argentina/Buenos_Aires")
              .format("YYYY-MM-DDTHH:mm:ss");

            const newRainAccumulation = interval.values.rainAccumulation || 0;
            rainData.rainAccumulation += newRainAccumulation;
            saveRainData(rainData);

            return {
              time: adjustedTime,
              rainAccumulation: newRainAccumulation,
            };
          })
        : response.data.timelines.minutely.map((interval) => {
            const adjustedTime = moment(interval.time)
              .tz("America/Argentina/Buenos_Aires")
              .format("YYYY-MM-DDTHH:mm:ss");

            return {
              time: adjustedTime,
              precipitationProbability:
                interval.values.precipitationProbability || 0,
              windSpeed: interval.values.windSpeed || 0,
              weatherCode: interval.values.weatherCode || 0,
              rainAccumulation: interval.values.rainAccumulation || 0,
            };
          });

    res.json(data.slice(0, timesteps === "hourly" ? 6 : 10));
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
app.get("/time", (req, res) => {
  ntpClient.getNetworkTime("2.ar.pool.ntp.org", 123, (err, date) => {
    if (err) {
      console.error("Error al obtener la hora NTP:", err);
      return res.status(500).send("Error al obtener la hora");
    }

    const argentinaTime = new Date(date.getTime() - 3 * 60 * 60 * 1000);
    const formattedArgentinaTime = argentinaTime.toISOString();

    res.json({
      time: formattedArgentinaTime,
    });
  });
});

const estadoFilePath = "./riegoEstado.json";

function cargarEstado() {
  try {
    if (fs.existsSync(estadoFilePath)) {
      const data = fs.readFileSync(estadoFilePath, "utf8");
      return JSON.parse(data).riegoEstado || 0;
    }
  } catch (error) {
    console.error("Error al cargar el estado:", error);
  }
  return 0;
}

function guardarEstado(nuevoEstado) {
  try {
    fs.writeFileSync(
      estadoFilePath,
      JSON.stringify({ riegoEstado: nuevoEstado }),
      "utf8"
    );
  } catch (error) {
    console.error("Error al guardar el estado:", error);
  }
}

let riegoEstado = cargarEstado();

app.get("/getRiegoEstado", (req, res) => {
  res.json({ estado_riego: riegoEstado });
});

app.get("/setRiegoEstado", (req, res) => {
  const estado = parseInt(req.query.riego_estado, 10);

  if ([0, 1, 2, 3, 4].includes(estado)) {
    riegoEstado = estado;
    guardarEstado(riegoEstado); // Guardar el estado en el archivo
    res.json({ message: "Estado del riego actualizado correctamente." });
  } else {
    res.status(400).json({ error: "Estado no válido" });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});
