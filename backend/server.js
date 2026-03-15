import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import ddrRoutes from "./routes/ddrRoutes.js";

dotenv.config();

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET","POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

/*
Serve uploaded images
*/
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

app.use("/api/ddr", ddrRoutes);

const PORT = 5000;

app.listen(PORT, () => {
  console.log(`DDR Backend running on port ${PORT}`);
});