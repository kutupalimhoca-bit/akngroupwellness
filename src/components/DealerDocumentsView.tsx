import React, { useEffect, useMemo, useState } from 'react';
import { Download, Eye, FileText, Film, Image as ImageIcon, Presentation, Search, X } from 'lucide-react';
import { getMemberWalletToken } from '../utils/authManager';
import {
  DOCUMENT_CATEGORIES,
  DocumentKind,
  PlatformDocument,
  formatFileSize,
  getAudienceLabel,
  getDocumentKind,
  memberListDocuments,
} from '../utils/documents';

const REFRESH_INTERVAL_MS = 20000;

const KIND_ICON: Record<DocumentKind, React.ComponentType<{ className?: string }>> = {
  pdf: FileText,
  video: Film,
  slides: Presentation,
  word: FileText,
  image: ImageIcon,
  other: FileText,
};

const KIND_TONE: Record<DocumentKind, string> = {
  pdf: 'bg-rose-100 text-rose-700',
  video: 'bg-violet-100 text-violet-700',
  slides: 'bg-amber-100 text-amber-700',
  word: 'bg-sky-100 text-sky-700',
  image: 'bg-emerald-100 text-emerald-700',
  other: 'bg-slate-100 text-slate-700',
};

export const DealerDocumentsView: React.FC = () => {
  const [documents, setDocuments] = useState<PlatformDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string>('ALL');
  const [preview, setPreview] = useState<PlatformDocument | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const token = getMemberWalletToken();
      if (!token) {
        if (!cancelled) {
          setError('Güvenli bayi oturumu bulunamadı; yeniden giriş yapın.');
          setLoading(false);
        }
        return;
      }
      try {
        const data = await memberListDocuments(token);
        if (cancelled) return;
        setDocuments(data.documents);
        setError(data.storage_ready ? null : 'Doküman deposu şu anda kullanılamıyor.');
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Dokümanlar yüklenemedi.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const interval = window.setInterval(load, REFRESH_INTERVAL_MS);
    window.addEventListener('focus', load);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', load);
    };
  }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return documents.filter((doc) => {
      if (category !== 'ALL' && doc.category !== category) return false;
      if (!query) return true;
      return [doc.title, doc.description, doc.category].some((value) => value.toLowerCase().includes(query));
    });
  }, [documents, search, category]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-slate-900">Dokümanlar</h2>
          <p className="text-xs text-slate-500">Eğitim, sunum, katalog ve video materyalleri. Yeni dosyalar otomatik görünür.</p>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Doküman ara..."
            className="pl-8 pr-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900 w-64"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {['ALL', ...DOCUMENT_CATEGORIES].map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setCategory(item)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold cursor-pointer transition-colors ${
              category === item ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {item === 'ALL' ? 'Tümü' : item}
          </button>
        ))}
      </div>

      {error && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{error}</p>}

      {loading ? (
        <p className="text-xs text-slate-500">Dokümanlar yükleniyor...</p>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-slate-500">Bu filtrelerle eşleşen doküman bulunamadı.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((doc) => {
            const kind = getDocumentKind(doc.file_type);
            const Icon = KIND_ICON[kind];
            const canPreview = kind === 'pdf' || kind === 'video';
            return (
              <article key={doc.id} className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col gap-3 shadow-xs">
                <div className="flex items-start gap-3">
                  <div className={`p-2.5 rounded-lg ${KIND_TONE[kind]}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-slate-900 truncate">{doc.title}</h3>
                    <p className="text-[11px] text-slate-500 uppercase tracking-wide">
                      {doc.file_type} · {formatFileSize(doc.file_size)} · {doc.category}
                    </p>
                  </div>
                </div>
                {doc.description && <p className="text-xs text-slate-600 line-clamp-3">{doc.description}</p>}
                <div className="flex items-center justify-between gap-2 mt-auto pt-2 border-t border-slate-100">
                  <span className="text-[10px] text-slate-400">{getAudienceLabel(doc.target_audience)}</span>
                  <div className="flex items-center gap-2">
                    {canPreview && (
                      <button
                        type="button"
                        onClick={() => setPreview(doc)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        Önizle
                      </button>
                    )}
                    <a
                      href={doc.file_url}
                      download={doc.file_name}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-700 text-white text-xs font-semibold"
                    >
                      <Download className="w-3.5 h-3.5" />
                      İndir
                    </a>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {preview && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-4"
          onClick={() => setPreview(null)}
        >
          <div
            className="bg-white rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
              <h4 className="text-sm font-bold text-slate-900 truncate">{preview.title}</h4>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 bg-slate-900 min-h-[60vh] flex items-center justify-center">
              {getDocumentKind(preview.file_type) === 'video' ? (
                <video src={preview.file_url} controls autoPlay className="max-h-[75vh] w-full" />
              ) : (
                <iframe src={preview.file_url} title={preview.title} className="w-full h-[75vh] bg-white" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
