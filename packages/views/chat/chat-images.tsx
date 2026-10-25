"use client";

import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import i18next from "i18next";
import { toast } from "sonner";
import { Button } from "@lynse/ui/components/ui/button";
import { Camera, FileText, Image as ImageIcon, Plus, Loader2, X } from "../icons";
import { Popover, PopoverContent, PopoverTrigger } from "@lynse/ui/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@lynse/ui/components/ui/dialog";
import { useChatStore } from "../workspace/hooks/use-chat-store";
import type { ChatAttachment } from "../workspace/types";

export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_IMAGES_BYTES = 10 * 1024 * 1024;
export const CHAT_DOCUMENT_ACCEPT = ".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.md,.markdown,.txt,.csv";
const DOCUMENT_EXTENSIONS = new Set(CHAT_DOCUMENT_ACCEPT.split(","));
export const CHAT_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";

export function imageCopy() {
  const zh = i18next.language?.toLowerCase().startsWith("zh");
  return zh ? {
    add: "添加", photo: "拍照", album: "相册", file: "文件", cancel: "取消", cameraLoading: "正在打开相机…", cameraError: "无法打开相机，请检查相机权限或从相册、文件中选择", remove: "移除附件", reading: "正在读取附件…",
    limit: "最多 4 张图片（单张 5 MB）和 4 份文档（单份 10 MB），总计不超过 30 MB",
    invalid: "请选择有效的 PNG、JPEG 或 WebP 图片",
    failed: "附件读取失败，请重新选择",
    prompt: "请查看并说明这些附件的内容。",
    hint: "支持图片和常用文档，可结合对话内容提问",
  } : {
    add: "Add", photo: "Take photo", album: "Photo library", file: "Files", cancel: "Cancel", cameraLoading: "Opening camera…", cameraError: "Could not open the camera. Check its permission or choose an existing file.", remove: "Remove attachment", reading: "Reading attachments…",
    limit: "Up to 4 images (5 MB each) and 4 documents (10 MB each), 30 MB total",
    invalid: "Choose a valid PNG, JPEG or WebP image",
    failed: "Could not read the attachment. Please choose it again.",
    prompt: "Describe the attached content.",
    hint: "Add images or documents and ask using your conversation context",
  };
}

export interface ChatImageDraft {
  id: string;
  name: string;
  size: number;
  dataUrl: string;
  kind: "image" | "document";
}

export function readChatImage(file: File): Promise<ChatImageDraft> {
  if (!file.size || file.size > MAX_CHAT_IMAGE_BYTES) return Promise.reject(new Error(imageCopy().limit));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(imageCopy().failed));
    reader.onabort = () => reject(new Error(imageCopy().failed));
    reader.onload = () => {
      try {
        const encoded = String(reader.result).split(",")[1] ?? "";
        const bytes = atob(encoded);
        const mime = bytes.startsWith("\x89PNG\r\n\x1a\n") && bytes.slice(12, 16) === "IHDR" ? "image/png"
          : bytes.startsWith("\xff\xd8\xff") && bytes.endsWith("\xff\xd9") ? "image/jpeg"
          : bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.slice(12, 16)) ? "image/webp" : null;
        if (!mime || (file.type && file.type !== mime)) throw new Error(imageCopy().invalid);
        resolve({ id: crypto.randomUUID(), name: file.name || "image", size: file.size, kind: "image", dataUrl: `data:${mime};base64,${encoded}` });
      } catch (error) { reject(error instanceof Error ? error : new Error(imageCopy().invalid)); }
    };
    reader.readAsDataURL(file);
  });
}

export function readChatDocument(file: File): Promise<ChatImageDraft> {
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!DOCUMENT_EXTENSIONS.has(ext)) return Promise.reject(new Error("Supported: PDF, DOC/DOCX, PPT/PPTX, XLS/XLSX, MD, TXT, CSV"));
  if (!file.size || file.size > 10 * 1024 * 1024) return Promise.reject(new Error(imageCopy().limit));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(imageCopy().failed));
    reader.onabort = () => reject(new Error(imageCopy().failed));
    reader.onload = () => resolve({id:crypto.randomUUID(), name:file.name, size:file.size, kind:"document", dataUrl:String(reader.result)});
    reader.readAsDataURL(file);
  });
}

export function readChatAttachment(file: File) {
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name) ? readChatImage(file) : readChatDocument(file);
}

/** Drafts are transient and scoped to the account, assistant and conversation. */
export function useChatImages(conversationKey: string) {
  const userId = useChatStore(state => state.userId);
  const scope = `${userId}:${conversationKey}`;
  const owner = useRef(scope);
  const epoch = useRef(0);
  const busy = useRef(false);
  const values = useRef<ChatImageDraft[]>([]);
  const [drafts, setDrafts] = useState<ChatImageDraft[]>([]);
  const [reading, setReading] = useState(false);
  if (owner.current !== scope) {
    owner.current = scope;
    epoch.current += 1;
    values.current = [];
    busy.current = false;
  }
  useEffect(() => { setDrafts([]); setReading(false); }, [scope]);
  useEffect(() => () => { epoch.current += 1; }, []);
  const clear = () => {
    epoch.current += 1; values.current = []; busy.current = false;
    setDrafts([]); setReading(false);
  };
  const add = async (files: File[]) => {
    if (!files.length || busy.current) return;
    const incomingImages = files.filter(file => file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name));
    const imageCount = values.current.filter(item => item.kind === "image").length + incomingImages.length;
    const documentCount = values.current.filter(item => item.kind === "document").length + files.length - incomingImages.length;
    const imageBytes = values.current.filter(item => item.kind === "image").reduce((n, item) => n + item.size, 0) + incomingImages.reduce((n, file) => n + file.size, 0);
    const total = values.current.reduce((n, item) => n + item.size, 0) + files.reduce((n, file) => n + file.size, 0);
    if (imageCount > MAX_CHAT_IMAGES || documentCount > 4 || imageBytes > MAX_CHAT_IMAGES_BYTES || total - imageBytes > 20 * 1024 * 1024 || total > 30 * 1024 * 1024) {
      toast.error(imageCopy().limit); return;
    }
    const expectedOwner = owner.current;
    const expectedEpoch = epoch.current;
    busy.current = true; setReading(true);
    try {
      const images = await Promise.all(files.map(readChatAttachment));
      if (owner.current !== expectedOwner || epoch.current !== expectedEpoch) return;
      values.current = [...values.current, ...images];
      setDrafts(values.current);
    } catch (error) {
      if (owner.current === expectedOwner && epoch.current === expectedEpoch) toast.error(error instanceof Error ? error.message : imageCopy().failed);
    } finally {
      if (owner.current === expectedOwner && epoch.current === expectedEpoch) { busy.current = false; setReading(false); }
    }
  };
  const remove = (id: string) => { values.current = values.current.filter(image => image.id !== id); setDrafts(values.current); };
  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.items ?? []).filter(item => item.kind === "file" && item.type.startsWith("image/"))
      .map(item => item.getAsFile()).filter((file): file is File => file !== null);
    if (files.length) { event.preventDefault(); void add(files); }
  };
  return { scope, drafts: owner.current === scope ? drafts.filter(image => values.current.includes(image)) : [], reading, add, clear, remove, onPaste };
}

export function ChatImagePicker({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const album = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [camera, setCamera] = useState(false);
  const selected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = ""; onFiles(selectedFiles);
  };
  return <>
    <input ref={album} type="file" accept={CHAT_IMAGE_ACCEPT} multiple hidden aria-label={imageCopy().album} onChange={selected} />
    <input ref={files} type="file" accept={`${CHAT_IMAGE_ACCEPT},${CHAT_DOCUMENT_ACCEPT}`} multiple hidden aria-label={imageCopy().file} onChange={selected} />
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" disabled={disabled}
        title={imageCopy().add} aria-label={imageCopy().add}><Plus className="size-4" /></Button>} />
      <PopoverContent side="top" align="start" className="w-40 gap-0.5 p-1">
        <Button type="button" variant="ghost" className="justify-start gap-2" onClick={() => { setOpen(false); setCamera(true); }}><Camera className="size-4" />{imageCopy().photo}</Button>
        <Button type="button" variant="ghost" className="justify-start gap-2" onClick={() => { setOpen(false); album.current?.click(); }}><ImageIcon className="size-4" />{imageCopy().album}</Button>
        <Button type="button" variant="ghost" className="justify-start gap-2" onClick={() => { setOpen(false); files.current?.click(); }}><FileText className="size-4" />{imageCopy().file}</Button>
      </PopoverContent>
    </Popover>
    <ChatCamera open={camera} onClose={() => setCamera(false)} onFiles={onFiles} />
  </>;
}

function ChatCamera({open, onClose, onFiles}: {open:boolean; onClose:()=>void; onFiles:(files:File[])=>void}) {
  const video = useRef<HTMLVideoElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current=true; return () => {mounted.current=false;}; }, []);
  const [ready,setReady] = useState(false);
  const [failed,setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let disposed=false;
    let stream: MediaStream | undefined;
    setReady(false); setFailed(false);
    if (!navigator.mediaDevices?.getUserMedia) { setFailed(true); return; }
    void navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"},audio:false}).then(value => {
      if (disposed) { value.getTracks().forEach(track=>track.stop()); return; }
      stream=value;
      if (video.current) video.current.srcObject=value;
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed=true; stream?.getTracks().forEach(track=>track.stop()); };
  },[open]);
  const capture=() => {
    const source=video.current;
    if (!source?.videoWidth || !source.videoHeight) return;
    const canvas=document.createElement("canvas");
    const scale=Math.min(1,1920/Math.max(source.videoWidth,source.videoHeight));
    canvas.width=Math.round(source.videoWidth*scale); canvas.height=Math.round(source.videoHeight*scale);
    const context=canvas.getContext("2d");
    if (!context) { setFailed(true); return; }
    context.drawImage(source,0,0,canvas.width,canvas.height);
    canvas.toBlob(blob=>{ if (!mounted.current) return; if (!blob) {setFailed(true);return;} onFiles([new File([blob],`photo-${Date.now()}.jpg`,{type:"image/jpeg"})]);onClose(); },"image/jpeg",0.85);
  };
  return <Dialog open={open} onOpenChange={value=>{if(!value)onClose();}}>
    <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{imageCopy().photo}</DialogTitle></DialogHeader>
      {failed ? <p role="alert" className="text-sm text-muted-foreground">{imageCopy().cameraError}</p> : <>
        <video ref={video} autoPlay playsInline muted onLoadedMetadata={()=>setReady(true)} className="max-h-80 w-full rounded-lg bg-muted" />
        {!ready && <p role="status" className="text-sm text-muted-foreground">{imageCopy().cameraLoading}</p>}
      </>}
      <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>{imageCopy().cancel}</Button><Button onClick={capture} disabled={!ready || failed}>{imageCopy().photo}</Button></div>
    </DialogContent>
  </Dialog>;
}

export function ChatImageTray({ images }: { images: ReturnType<typeof useChatImages> }) {
  if (!images.drafts.length && !images.reading) return null;
  return <div className="flex flex-wrap gap-2 px-2.5 py-2" aria-label={imageCopy().add}>
    {images.drafts.map(image => <div key={image.id} className="relative rounded-lg border border-border bg-muted p-1">
      {image.kind === "image" ? <img src={image.dataUrl} alt={image.name} className="size-16 rounded-md object-cover" />
        : <div className="flex h-16 w-36 items-center gap-2 px-2" title={image.name}><FileText className="size-5 shrink-0" /><span className="truncate text-xs">{image.name}</span></div>}
      <button type="button" className="absolute -right-1 -top-1 rounded-full border border-border bg-background p-0.5 text-foreground"
        aria-label={`${imageCopy().remove}: ${image.name}`} onClick={() => images.remove(image.id)}><X className="size-3" /></button>
    </div>)}
    {images.reading && <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />{imageCopy().reading}</span>}
  </div>;
}

export function imageAttachments(images: ChatImageDraft[]): ChatAttachment[] {
  return images.map(image => ({ id: image.id, name: image.name, type: image.kind === "image" ? "image" : "file", url: image.kind === "image" ? image.dataUrl : undefined, inputAttachment: true }));
}

export function UserImagePreviews({ attachments }: { attachments?: ChatAttachment[] }) {
  const images = attachments?.filter(item => item.inputAttachment && item.url?.startsWith("data:image/")) ?? [];
  return images.length ? <div className="flex flex-wrap justify-end gap-2">
    {images.map(image => <img key={image.id} src={image.url} alt={image.name || "image"} className="max-h-48 max-w-64 rounded-lg border border-border object-contain" />)}
  </div> : null;
}

export function attachmentInput(drafts: ChatImageDraft[]) {
  const images=drafts.filter(item=>item.kind === "image").map(item=>item.dataUrl);
  const documents=drafts.filter(item=>item.kind === "document").map(item=>({name:item.name,dataUrl:item.dataUrl}));
  return {...(images.length?{images}:{}),...(documents.length?{documents}:{})};
}
