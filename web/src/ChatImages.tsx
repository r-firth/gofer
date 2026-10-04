import { useEffect, useRef, useState } from "react";
import { Download, Expand, ImageOff, X } from "lucide-react";
import "./chat-images.css";

export type ChatImage = {
  id: string;
  url: string;
  mime_type: string;
  name: string;
  caption: string;
  width: number;
  height: number;
  bytes: number;
  device_id?: string;
};

function ImageViewer({
  image,
  onClose,
}: {
  image: ChatImage;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [actualSize, setActualSize] = useState(false);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="image-viewer"
      aria-label={image.caption || image.name}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <div>
          <strong>{image.caption || image.name}</strong>
          <span>
            {image.width} × {image.height} ·{" "}
            {image.mime_type.replace("image/", "").toUpperCase()}
          </span>
        </div>
        <button
          onClick={() => setActualSize(!actualSize)}
          aria-pressed={actualSize}
        >
          {actualSize ? "Fit image" : "Actual size"}
        </button>
        <a
          href={image.url}
          download={image.name === "Image" ? image.id : image.name}
          aria-label="Download original"
        >
          <Download size={17} />
        </a>
        <button onClick={onClose} aria-label="Close image" autoFocus>
          <X size={20} />
        </button>
      </header>
      <div className={`image-viewer-canvas ${actualSize ? "actual-size" : ""}`}>
        <img
          src={image.url}
          alt={image.caption || image.name}
          width={image.width}
          height={image.height}
        />
      </div>
    </dialog>
  );
}

function ImagePreview({ image }: { image: ChatImage }) {
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = image.caption || image.name;
  return (
    <figure className="chat-image">
      {failed ? (
        <div className="chat-image-unavailable" role="status">
          <ImageOff size={20} />
          <span>Image unavailable</span>
          <a href={image.url} target="_blank" rel="noreferrer">
            Open original ↗
          </a>
        </div>
      ) : (
        <button
          className="chat-image-preview"
          onClick={() => setExpanded(true)}
          aria-label={`Expand ${label}`}
        >
          <img
            src={image.url}
            alt={label}
            width={image.width}
            height={image.height}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
          />
          <span className="chat-image-expand" aria-hidden="true">
            <Expand size={15} />
          </span>
        </button>
      )}
      <figcaption>
        <span className="chat-image-caption" title={label}>
          {label}
        </span>
        <span className="chat-image-dimensions">
          {image.width} × {image.height}
        </span>
        <a
          href={image.url}
          download={image.name === "Image" ? image.id : image.name}
          aria-label={`Download ${label}`}
          title="Download original"
        >
          <Download size={14} />
        </a>
      </figcaption>
      {expanded && (
        <ImageViewer image={image} onClose={() => setExpanded(false)} />
      )}
    </figure>
  );
}

export function ChatImages({
  images,
  errors,
}: {
  images?: ChatImage[];
  errors?: string[];
}) {
  // All displayed files go through the authenticated artifact route. Never turn
  // an arbitrary filesystem path or tool-supplied URL into a browser request.
  const valid = Array.isArray(images)
    ? images.filter(
        (image) =>
          /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(image.id) &&
          image.url === `/api/artifacts/${image.id}`,
      )
    : [];
  if (!valid.length && !errors?.length) return null;
  return (
    <div className="chat-images">
      {valid.map((image) => (
        <ImagePreview key={image.id} image={image} />
      ))}
      {errors?.map((error, index) => (
        <p className="chat-image-error" role="status" key={index}>
          <ImageOff size={14} /> Couldn’t display image: {error}
        </p>
      ))}
    </div>
  );
}
