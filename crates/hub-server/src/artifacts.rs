//! Durable chat images. Only opaque, content-addressed IDs are exposed by HTTP;
//! filesystem paths are read by agent tools, never by a browser file endpoint.
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use image::{ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

pub const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
/// The most pictures one message can carry.
pub const MAX_MESSAGE_IMAGES: usize = 10;
/// What a model is handed: Claude takes up to 5 MB of base64 and 8000 pixels a side, and reads
/// nothing finer than about 1600 pixels a side anyway. Larger pictures go as a smaller copy.
const MODEL_IMAGE_BYTES: usize = 3_750_000;
const MODEL_IMAGE_SIDE: u32 = 2000;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImageAttachment {
    pub id: String,
    pub url: String,
    pub mime_type: String,
    pub name: String,
    pub caption: String,
    pub width: u32,
    pub height: u32,
    pub bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

#[derive(Clone)]
pub struct Artifacts {
    root: PathBuf,
}

impl Artifacts {
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root)?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        Ok(Self { root })
    }

    pub fn path(&self, id: &str) -> Option<PathBuf> {
        let (hash, extension) = id.split_once('.')?;
        (hash.len() == 64
            && hash.bytes().all(|b| b.is_ascii_hexdigit())
            && matches!(extension, "png" | "jpg" | "gif" | "webp"))
        .then(|| self.root.join(id))
    }

    pub fn save(
        &self,
        bytes: &[u8],
        caption: &str,
        source: Option<&str>,
        device: Option<&str>,
    ) -> Result<ImageAttachment> {
        if bytes.len() > MAX_IMAGE_BYTES {
            bail!("Images are limited to 25 MB");
        }
        let format =
            image::guess_format(bytes).context("Expected a PNG, JPEG, GIF, or WebP image")?;
        let (extension, mime) = match format {
            ImageFormat::Png => ("png", "image/png"),
            ImageFormat::Jpeg => ("jpg", "image/jpeg"),
            ImageFormat::Gif => ("gif", "image/gif"),
            ImageFormat::WebP => ("webp", "image/webp"),
            _ => bail!("Expected a PNG, JPEG, GIF, or WebP image"),
        };
        let (width, height) = ImageReader::with_format(Cursor::new(bytes), format)
            .into_dimensions()
            .context("Invalid image header")?;
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 64_000_000 {
            bail!("Images are limited to 64 megapixels");
        }
        let id = format!("{:x}.{extension}", Sha256::digest(bytes));
        let path = self.root.join(&id);
        if !path.exists() {
            let temporary = self.root.join(format!(".{}", uuid::Uuid::new_v4()));
            let result = (|| -> Result<()> {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&temporary)?;
                file.write_all(bytes)?;
                file.sync_all()?;
                fs::rename(&temporary, &path)?;
                Ok(())
            })();
            if result.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            result?;
        }
        let name = source
            .and_then(|p| Path::new(p).file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("Image")
            .to_owned();
        Ok(ImageAttachment {
            url: format!("/api/artifacts/{id}"),
            id,
            mime_type: mime.into(),
            name,
            caption: caption.chars().take(500).collect(),
            width,
            height,
            bytes: bytes.len(),
            source_path: source.map(str::to_owned),
            device_id: device.map(str::to_owned),
        })
    }

    pub fn local(&self, path: &str, caption: &str) -> Result<ImageAttachment> {
        if !Path::new(path).is_absolute() {
            bail!("Use an absolute image path");
        }
        if !fs::metadata(path)
            .context("Could not open image file")?
            .is_file()
        {
            bail!("Image path must be a regular file");
        }
        let file = File::open(path).context("Could not open image file")?;
        if !file.metadata()?.is_file() {
            bail!("Image path must be a regular file");
        }
        let mut bytes = Vec::new();
        file.take(MAX_IMAGE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        self.save(&bytes, caption, Some(path), Some("local"))
    }

    /// A picture the owner attached to a message. Its name is only a label for the thread.
    pub fn upload(&self, bytes: &[u8], name: &str) -> Result<ImageAttachment> {
        let mut image = self.save(bytes, "", None, None)?;
        let name: String = Path::new(name)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_control())
            .take(200)
            .collect();
        if !name.trim().is_empty() {
            image.name = name;
        }
        Ok(image)
    }

    /// A stored picture by its ID, as the attachment it was saved as.
    pub fn stored(&self, id: &str, name: &str) -> Result<ImageAttachment> {
        let path = self.path(id).context("Unknown image")?;
        let bytes = fs::read(path).context("Unknown image")?;
        self.upload(&bytes, name)
    }

    /// An absolute path to the picture to hand a model: the original when it is within what a
    /// model takes, otherwise a smaller copy, stored beside it under its own content hash.
    pub fn for_model(&self, image: &ImageAttachment) -> Result<PathBuf> {
        let path = self.path(&image.id).context("Unknown image")?;
        if image.bytes <= MODEL_IMAGE_BYTES && image.width.max(image.height) <= MODEL_IMAGE_SIDE {
            return Ok(fs::canonicalize(path)?);
        }
        let picture = image::load_from_memory(&fs::read(&path)?).context("Invalid image")?;
        let picture = picture.resize(
            MODEL_IMAGE_SIDE,
            MODEL_IMAGE_SIDE,
            image::imageops::FilterType::Triangle,
        );
        let mut bytes = Vec::new();
        if picture.color().has_alpha() {
            picture.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)?;
        }
        if bytes.is_empty() || bytes.len() > MODEL_IMAGE_BYTES {
            bytes.clear();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 85)
                .encode_image(&picture.to_rgb8())?;
        }
        let copy = self.save(&bytes, "", None, None)?;
        Ok(fs::canonicalize(self.root.join(copy.id))?)
    }

    /// Normalize native image-generation, view-image, and arbitrary tool image
    /// blocks through the same attachment path. Text and provenance stay intact.
    pub fn normalize(&self, payload: &mut Value) {
        if payload.get("images").is_some() || payload.get("image_errors").is_some() {
            return;
        }
        let mut images = Vec::new();
        let mut errors = Vec::new();
        if let Some(result) = payload.pointer_mut("/result/result") {
            self.visit(result, &mut images, &mut errors);
        }
        if !images.is_empty() {
            payload["images"] = json!(images);
        }
        if !errors.is_empty() {
            payload["image_errors"] = json!(errors);
        }
    }

    fn encoded(&self, data: &str, caption: &str, path: Option<&str>) -> Result<ImageAttachment> {
        let encoded = if data.starts_with("data:") {
            let (header, encoded) = data.split_once(',').context("Invalid image data URL")?;
            if !header.starts_with("data:image/") || !header.ends_with(";base64") {
                bail!("Expected a base64 image data URL");
            }
            encoded
        } else {
            data
        };
        if encoded.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
            bail!("Images are limited to 25 MB");
        }
        let bytes = B64.decode(encoded).context("Invalid base64 image")?;
        self.save(&bytes, caption, path, None)
    }

    fn visit(
        &self,
        value: &mut Value,
        images: &mut Vec<ImageAttachment>,
        errors: &mut Vec<String>,
    ) {
        let kind = value["type"].as_str().unwrap_or("").to_owned();
        let image = match kind.as_str() {
            "imageGeneration" | "image_generation_call"
                if value["result"].is_string() || value["savedPath"].is_string() =>
            {
                let path = value["savedPath"].as_str();
                let image = match value["result"].as_str().filter(|s| !s.is_empty()) {
                    Some(data) => self.encoded(data, "Generated image", path),
                    None => self.local(path.unwrap_or(""), "Generated image"),
                };
                if image.is_ok() {
                    value.as_object_mut().unwrap().remove("result");
                }
                Some(image)
            }
            "imageView" | "localImage" | "local_image" if value["path"].is_string() => {
                Some(self.local(value["path"].as_str().unwrap(), ""))
            }
            "image" if value["data"].is_string() => {
                let image = self.encoded(value["data"].as_str().unwrap(), "", None);
                if image.is_ok() {
                    value.as_object_mut().unwrap().remove("data");
                }
                Some(image)
            }
            "input_image" | "inputImage" | "image_url" | "image"
                if value.get("image_url").is_some() || value.get("imageUrl").is_some() =>
            {
                let key = if value.get("image_url").is_some() {
                    "image_url"
                } else {
                    "imageUrl"
                };
                let url = value[key]
                    .as_str()
                    .or_else(|| value[key]["url"].as_str())
                    .unwrap_or("");
                if url.starts_with("data:") {
                    let image = self.encoded(url, "", None);
                    if image.is_ok() {
                        value.as_object_mut().unwrap().remove(key);
                    }
                    Some(image)
                } else {
                    None
                }
            }
            _ => None,
        };
        if let Some(result) = image {
            match result {
                Ok(image) => {
                    value["attachment"] = json!(image);
                    if !images.iter().any(|i| i.id == image.id) {
                        images.push(image);
                    }
                }
                Err(error) => {
                    value["image_error"] = json!(error.to_string());
                    errors.push(error.to_string());
                }
            }
            return;
        }
        match value {
            Value::Array(values) => {
                for value in values {
                    self.visit(value, images, errors);
                }
            }
            Value::Object(fields) => {
                for (key, value) in fields {
                    // Our own attachments have already been validated and copied.
                    if key == "images" {
                        if let Ok(attached) =
                            serde_json::from_value::<Vec<ImageAttachment>>(value.clone())
                        {
                            for image in attached {
                                if self.path(&image.id).is_some()
                                    && !images.iter().any(|i| i.id == image.id)
                                {
                                    images.push(image);
                                }
                            }
                        }
                    } else if key != "attachment" {
                        self.visit(value, images, errors);
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let picture = image::RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([(x % 251) as u8, (y % 241) as u8, ((x ^ y) % 239) as u8])
        });
        let mut bytes = Vec::new();
        picture
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        bytes
    }

    #[test]
    fn uploads_keep_a_clean_name_and_are_found_again_by_id() {
        let directory = tempfile::tempdir().unwrap();
        let artifacts = Artifacts::new(directory.path().join("artifacts")).unwrap();
        let image = artifacts
            .upload(&png(3, 2), "../../etc/screen\u{7} shot.png")
            .unwrap();
        assert_eq!(image.name, "screen shot.png");
        assert_eq!((image.width, image.height), (3, 2));
        assert!(image.source_path.is_none() && image.device_id.is_none());
        assert_eq!(artifacts.upload(&png(3, 2), "").unwrap().name, "Image");
        let again = artifacts.stored(&image.id, "renamed.png").unwrap();
        assert_eq!(
            (again.id.as_str(), again.name.as_str()),
            (image.id.as_str(), "renamed.png")
        );
        assert!(artifacts.stored(&"0".repeat(64), "").is_err());
        assert!(artifacts.stored("../secret.png", "").is_err());
        assert!(artifacts.upload(b"not an image", "notes.txt").is_err());
        assert!(
            artifacts
                .upload(b"<svg xmlns='http://www.w3.org/2000/svg'/>", "a.svg")
                .is_err()
        );
    }

    #[test]
    fn a_model_gets_the_original_or_a_copy_within_its_limits() {
        let directory = tempfile::tempdir().unwrap();
        let artifacts = Artifacts::new(directory.path().join("artifacts")).unwrap();
        let small = artifacts.upload(&png(40, 30), "small.png").unwrap();
        let path = artifacts.for_model(&small).unwrap();
        assert!(path.is_absolute());
        assert_eq!(path.file_name().unwrap().to_str(), Some(small.id.as_str()));

        let large = artifacts.upload(&png(4000, 1000), "wide.png").unwrap();
        let copy = artifacts.for_model(&large).unwrap();
        assert_ne!(copy.file_name().unwrap().to_str(), Some(large.id.as_str()));
        let bytes = fs::read(&copy).unwrap();
        assert!(bytes.len() <= MODEL_IMAGE_BYTES);
        let (width, height) = ImageReader::new(Cursor::new(&bytes))
            .with_guessed_format()
            .unwrap()
            .into_dimensions()
            .unwrap();
        assert_eq!((width, height), (2000, 500));
        // The original stays as it was uploaded.
        assert_eq!(
            fs::metadata(artifacts.path(&large.id).unwrap())
                .unwrap()
                .len() as usize,
            large.bytes
        );
    }
}
