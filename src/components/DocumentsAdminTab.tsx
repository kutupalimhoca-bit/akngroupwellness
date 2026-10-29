import React, { useEffect, useState } from 'react';
import { Download, FileText, Loader2, Pencil, Trash2, Upload, X } from 'lucide-react';
import {
  DOCUMENT_ACCEPT,
  DOCUMENT_AUDIENCE_OPTIONS,
  DOCUMENT_CATEGORIES,
  DOCUMENT_MAX_BYTES,
  PlatformDocument,
  adminCreateDocument,
  adminDeleteDocument,
  adminListDocuments,
  adminUpdateDocument,
  formatFileSize,
  getAudienceLabel,
  getDocumentKind,
  readFileAsBase64,
} from '../utils/documents';

interface DocumentsAdminTabProps {
  onSuccessMessage: (msg: string) => void;
}

const EMPTY_FORM = {
  title: '',
  description: '',
  category: DOCUMENT_CATEGORIES[0] as string,
  target_audience: 'ALL',
};

const ACCEPTED_EXTENSIONS = DOCUMENT_ACCEPT.split(',').map((ext) => ext.trim());

export const DocumentsAdminTab: React.FC<DocumentsAdminTabProps> = ({ onSuccessMessage }) => {
  const [form, setForm] = useState(EMPTY_FORM);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<PlatformDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState(EMPTY_FORM);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadDocuments = async () => {
    try {
      const data = await adminListDocuments();
      setDocuments(data.documents);
      setListError(data.storage_ready ? null : 'Doküman deposu kullanılamıyor. Firebase Admin ADC yapılandırmasını kontrol edin.');
    } catch (err: any) {
      setListError(err?.message || 'Dokümanlar yüklenemedi.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDocuments();
  }, []);

  const selectFile = (candidate: File | undefined) => {
    if (!candidate) return;
    const extension = candidate.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ACCEPTED_EXTENSIONS.includes(`.${extension}`)) {
      setFormError('Desteklenmeyen dosya türü. PDF, MP4, PPTX/PPT, DOCX veya resim yükleyin.');
      return;
    }
    if (candidate.size > DOCUMENT_MAX_BYTES) {
      setFormError('Dosya en fazla 100 MB olabilir.');
      return;
    }
    setFormError(null);
    setFile(candidate);
  };

  const handleUpload = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) {
      setFormError('Lütfen bir dosya seçin.');
      return;
    }
    if (form.title.trim().length < 2) {
      setFormError('Doküman başlığı en az 2 karakter olmalıdır.');
      return;
    }
    setUploading(true);
    setFormError(null);
    try {
      const content_base64 = await readFileAsBase64(file);
      const { document } = await adminCreateDocument({
        title: form.title.trim(),
        description: form.description.trim(),
        category: form.category,
        target_audience: form.target_audience,
        file_name: file.name,
        content_base64,
      });
      setDocuments((prev) => [document, ...prev]);
      setForm(EMPTY_FORM);
      setFile(null);
      onSuccessMessage(`"${document.title}" dokümanı yüklendi ve bayi panelinde yayına alındı.`);
    } catch (err: any) {
      setFormError(err?.message || 'Doküman yüklenemedi.');
    } finally {
      setUploading(false);
    }
  };

  const startEdit = (doc: PlatformDocument) => {
    setEditingId(doc.id);
    setEditDraft({
      title: doc.title,
      description: doc.description,
      category: doc.category,
      target_audience: doc.target_audience,
    });
  };

  const saveEdit = async (id: string) => {
    setBusyId(id);
    try {
      const { document } = await adminUpdateDocument(id, {
        title: editDraft.title.trim(),
        description: editDraft.description.trim(),
        category: editDraft.category,
        target_audience: editDraft.target_audience,
      });
      setDocuments((prev) => prev.map((doc) => (doc.id === id ? document : doc)));
      setEditingId(null);
      onSuccessMessage(`"${document.title}" dokümanı güncellendi.`);
    } catch (err: any) {
      setListError(err?.message || 'Doküman güncellenemedi.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (doc: PlatformDocument) => {
    if (!window.confirm(`"${doc.title}" dokümanı ve dosyası kalıcı olarak silinsin mi?`)) return;
    setBusyId(doc.id);
    try {
      await adminDeleteDocument(doc.id);
      setDocuments((prev) => prev.filter((item) => item.id !== doc.id));
      onSuccessMessage(`"${doc.title}" dokümanı silindi.`);
    } catch (err: any) {
      setListError(err?.message || 'Doküman silinemedi.');
    } finally {
      setBusyId(null);
    }
  };

  const inputClass = 'w-full px-3 py-2 rounded-lg bg-slate-900 border border-white/20 text-white text-xs';

  return (
    <div className="space-y-6">
      <form onSubmit={handleUpload} className="bg-slate-900/80 border border-white/10 rounded-xl p-5 space-y-4">
        <div>
          <h3 className="text-sm font-bold text-white">Doküman Yükle</h3>
          <p className="text-[11px] text-slate-400">
            Yüklenen dosyalar bayi panelinde anında görünür. Dosya türleri: PDF, MP4, PPTX/PPT, DOCX, PNG/JPG/WEBP.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-slate-300 text-xs font-semibold mb-1">Başlık *</label>
            <input
              type="text"
              required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Örn: Mart 2026 Ürün Katalogu"
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-slate-300 text-xs font-semibold mb-1">Kategori *</label>
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              className={inputClass}
            >
              {DOCUMENT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="block text-slate-300 text-xs font-semibold mb-1">Açıklama</label>
            <textarea
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-slate-300 text-xs font-semibold mb-1">Hedef Kitle</label>
            <select
              value={form.target_audience}
              onChange={(e) => setForm({ ...form, target_audience: e.target.value })}
              className={inputClass}
            >
              {DOCUMENT_AUDIENCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            selectFile(e.dataTransfer.files[0]);
          }}
          className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl p-6 cursor-pointer transition-colors ${
            dragging ? 'border-emerald-400 bg-emerald-500/10' : 'border-white/20 hover:border-white/40'
          }`}
        >
          <Upload className="w-6 h-6 text-slate-400" />
          <span className="text-xs text-slate-300">
            {file ? `${file.name} · ${formatFileSize(file.size)}` : 'Dosyayı sürükleyip bırakın veya seçmek için tıklayın'}
          </span>
          <input
            type="file"
            accept={DOCUMENT_ACCEPT}
            className="hidden"
            onChange={(e) => selectFile(e.target.files?.[0])}
          />
        </label>

        {formError && <p className="text-xs text-rose-300">{formError}</p>}

        <button
          type="submit"
          disabled={uploading}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50 cursor-pointer"
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          <span>{uploading ? 'Yükleniyor...' : 'Dokümanı Yükle'}</span>
        </button>
      </form>

      <div className="bg-slate-900/80 border border-white/10 rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-bold text-white">Yüklenen Dokümanlar ({documents.length})</h3>
        {listError && <p className="text-xs text-amber-300">{listError}</p>}
        {loading ? (
          <p className="text-xs text-slate-400">Yükleniyor...</p>
        ) : documents.length === 0 ? (
          <p className="text-xs text-slate-400">Henüz doküman yüklenmedi.</p>
        ) : (
          <ul className="divide-y divide-white/10">
            {documents.map((doc) => (
              <li key={doc.id} className="py-3">
                {editingId === doc.id ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <input
                      value={editDraft.title}
                      onChange={(e) => setEditDraft({ ...editDraft, title: e.target.value })}
                      className={inputClass}
                    />
                    <select
                      value={editDraft.category}
                      onChange={(e) => setEditDraft({ ...editDraft, category: e.target.value })}
                      className={inputClass}
                    >
                      {DOCUMENT_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                    <input
                      value={editDraft.description}
                      onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
                      className={inputClass}
                    />
                    <select
                      value={editDraft.target_audience}
                      onChange={(e) => setEditDraft({ ...editDraft, target_audience: e.target.value })}
                      className={inputClass}
                    >
                      {DOCUMENT_AUDIENCE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <div className="md:col-span-2 flex gap-2">
                      <button
                        type="button"
                        disabled={busyId === doc.id}
                        onClick={() => saveEdit(doc.id)}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold cursor-pointer disabled:opacity-50"
                      >
                        Kaydet
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="px-3 py-1.5 rounded-lg text-slate-300 hover:text-white text-xs cursor-pointer inline-flex items-center gap-1"
                      >
                        <X className="w-3.5 h-3.5" />
                        Vazgeç
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    <FileText className="w-5 h-5 text-slate-400 shrink-0" />
                    <div className="flex-1 min-w-[200px]">
                      <div className="text-xs font-bold text-white">{doc.title}</div>
                      <div className="text-[11px] text-slate-400">
                        {doc.category} · {getAudienceLabel(doc.target_audience)} · {getDocumentKind(doc.file_type)} ·{' '}
                        {formatFileSize(doc.file_size)}
                        {doc.uploaded_at ? ` · ${new Date(doc.uploaded_at).toLocaleDateString('tr-TR')}` : ''}
                      </div>
                    </div>
                    <a
                      href={doc.file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 rounded-lg text-slate-300 hover:text-white hover:bg-white/10"
                      title="Dosyayı aç"
                    >
                      <Download className="w-4 h-4" />
                    </a>
                    <button
                      type="button"
                      onClick={() => startEdit(doc)}
                      className="p-2 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 cursor-pointer"
                      title="Düzenle"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      disabled={busyId === doc.id}
                      onClick={() => handleDelete(doc)}
                      className="p-2 rounded-lg text-rose-300 hover:text-rose-200 hover:bg-rose-500/10 cursor-pointer disabled:opacity-50"
                      title="Sil"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
