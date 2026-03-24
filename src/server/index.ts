import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { createServer } from "http";
import path from "path";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const httpServer = createServer(app);

// دالة لتسجيل العمليات (Logging)
export function log(message: string) {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${message}`);
}

(async () => {
  // تسجيل مسارات اللعبة والـ Sockets
  await registerRoutes(httpServer, app);

  // إذا كنا في وضع الإنتاج (Render)، قم بتقديم ملفات الواجهة
  if (process.env.NODE_ENV === "production") {
    const publicPath = path.join(__dirname, "../../public");
    app.use(express.static(publicPath));
    
    app.get("*", (_req, res) => {
      res.sendFile(path.join(publicPath, "index.html"));
    });
  }

  const PORT = process.env.PORT || 10000;
  httpServer.listen(PORT, () => {
    log(`السيرفر يعمل الآن على المنفذ ${PORT}`);
  });
})();
