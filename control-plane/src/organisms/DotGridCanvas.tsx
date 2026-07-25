import { useRef } from "react";
import { type GridParams, useDotGrid } from "../hooks/useDotGrid";

interface DotGridCanvasProps {
  params: GridParams;
}

export function DotGridCanvas({ params }: DotGridCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useDotGrid(canvasRef, params);
  return <canvas id="bg" ref={canvasRef} />;
}
