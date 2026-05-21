import Cropper from "react-easy-crop";
import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Loader2, ZoomIn, RotateCcw } from "lucide-react";

interface CropArea { x: number; y: number; width: number; height: number; }
interface Point { x: number; y: number; }

interface Props {
  imageSrc: string;
  onConfirm: (blob: Blob) => Promise<void>;
  onCancel: () => void;
}

async function getCroppedBlob(imageSrc: string, pixelCrop: CropArea): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = imageSrc;
  });

  const canvas = document.createElement("canvas");
  canvas.width = pixelCrop.width;
  canvas.height = pixelCrop.height;
  const ctx = canvas.getContext("2d")!;

  ctx.drawImage(
    img,
    pixelCrop.x, pixelCrop.y, pixelCrop.width, pixelCrop.height,
    0, 0, pixelCrop.width, pixelCrop.height
  );

  return new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error("Canvas empty")), "image/jpeg", 0.92)
  );
}

export function AvatarCropModal({ imageSrc, onConfirm, onCancel }: Props) {
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<CropArea | null>(null);
  const [saving, setSaving] = useState(false);

  const onCropComplete = useCallback((_: CropArea, pixels: CropArea) => {
    setCroppedAreaPixels(pixels);
  }, []);

  const handleConfirm = async () => {
    if (!croppedAreaPixels) return;
    setSaving(true);
    try {
      const blob = await getCroppedBlob(imageSrc, croppedAreaPixels);
      await onConfirm(blob);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-card rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-sm font-medium">Crop Profile Photo</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Drag to reposition · scroll or use slider to zoom</p>
        </div>

        {/* Crop area */}
        <div className="relative bg-black" style={{ height: 280 }}>
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            cropShape="round"
            showGrid={false}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
            style={{
              containerStyle: { background: "#000" },
              cropAreaStyle: { border: "2px solid rgba(255,255,255,0.8)", boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)" },
            }}
          />
        </div>

        {/* Zoom slider */}
        <div className="px-5 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <ZoomIn className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Slider
              min={1}
              max={3}
              step={0.05}
              value={[zoom]}
              onValueChange={([v]) => setZoom(v)}
              className="flex-1"
            />
            <button
              onClick={() => { setZoom(1); setCrop({ x: 0, y: 0 }); }}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Reset"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="px-5 py-4 flex gap-3">
          <Button variant="outline" className="flex-1 rounded-full text-sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button className="flex-1 rounded-full text-sm gap-2" onClick={handleConfirm} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {saving ? "Uploading…" : "Save Photo"}
          </Button>
        </div>
      </div>
    </div>
  );
}
