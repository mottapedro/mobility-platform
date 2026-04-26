import { app } from "./app";
import { ExpireOffersService } from "./application/use-cases/ExpireOffersService";

// ⏱️ Job: expira offers pendentes vencidas a cada 10s
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

export { app };