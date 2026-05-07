import express from "express";
import cors, { CorsOptions } from "cors";
import dotenv from "dotenv";
import "dotenv/config";

import { rideRoutes } from "./presentation/routes/ride.routes";
import { offerRoutes } from "./presentation/routes/offer.routes";
import { passengerRoutes } from "./presentation/routes/passenger.routes";
import { authRoutes } from "./presentation/routes/auth.routes";
import { ExpireOffersService } from "./application/use-cases/ExpireOffersService";

dotenv.config();

const defaultAllowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
];

const envAllowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.FRONTEND_VERCEL_URL,
  process.env.CORS_ORIGINS,
]
  .filter((value): value is string => Boolean(value))
  .flatMap((value) => value.split(",").map((origin) => origin.trim()))
  .filter(Boolean);

const allowedOrigins = new Set<string>([
  ...defaultAllowedOrigins,
  ...envAllowedOrigins,
]);

function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;

  try {
    const hostname = new URL(origin).hostname;
    return hostname.endsWith(".vercel.app");
  } catch {
    return false;
  }
}

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Origin",
    "X-Requested-With",
    "Content-Type",
    "Accept",
    "Authorization",
    "ngrok-skip-browser-warning",
  ],
};

const app = express();
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());

app.use("/auth", authRoutes);
app.use("/rides", rideRoutes);
app.use("/offers", offerRoutes);
app.use("/passengers", passengerRoutes);

if (process.env.NODE_ENV !== "test") {
  const expireOffersService = new ExpireOffersService();
  setInterval(() => {
    expireOffersService.execute().catch((err) => {
      console.error("🔥 Erro no job de expiração de offers:", err);
    });
  }, 10_000);

  app.listen(3000, () => {
    console.log("🚀 Server running on port 3000");
    console.log("⏱️ Job de expiração de offers ativo (a cada 10s)");
  });
}

export { app };
