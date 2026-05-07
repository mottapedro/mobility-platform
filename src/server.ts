import { app } from "./app";
import { ExpireOffersService } from "./application/use-cases/ExpireOffersService";
import 'dotenv/config'

import cors from "cors";

app.use(cors({
  origin: "*", // (temporário para teste)
  credentials: true
}));

app.get("/health", (_req, res) => {
  return res.status(200).json({ status: "ok" });
});

const expireOffersService = new ExpireOffersService();
setInterval(() => {
  expireOffersService.execute().catch((err) => {
    console.error("🔥 Erro no job de expiração de offers:", err);
  });
}, 10_000);

app.listen(3000, "0.0.0.0", () => {
  console.log("🚀 Server running on port 3000");
  console.log("⏱️ Job de expiração de offers ativo (a cada 10s)");
  console.log("DATABASE_URL:", process.env.DATABASE_URL)
});

export { app };