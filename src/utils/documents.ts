import { getAdminToken } from './adminSession';

export const DOCUMENT_CATEGORIES = ['Eğitim', 'Sunum', 'Katalog', 'Video', 'Diğer'] as const;

export const DOCUMENT_AUDIENCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'ALL', label: 'Tüm bayiler' },
  { value: 'DOMESTIC', label: 'Sadece yurt içi' },
  { value: 'INTERNATIONAL', label: 'Sadece yurt dışı' },
  ...Array.from({ length: 7 }, (_, index) => ({
    value: `CAREER_LEVEL_${index + 1}`,
    label: `En az ${index + 1}. kariyer seviyesi`,
  })),
];

export const DOCUMENT_ACCEPT = '.pdf,.mp4,.pptx,.ppt,.docx,.png,.jpg,.jpeg,.webp';
export const DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;

export interface PlatformDocument {
  id: string;
  title: string;
  description: string;
  category: string;
  file_url: string;
  file_type: string;
  file_name: string;
  file_size: number;
  target_audience: string;
  uploaded_at: string | null;
}

export type DocumentKind = 'pdf' | 'video' | 'slides' | 'word' | 'image' | 'other';

export const getDocumentKind = (fileType: string): DocumentKind => {
  switch (fileType.toLowerCase()) {
    case 'pdf':
      return 'pdf';
    case 'mp4':
      return 'video';
    case 'ppt':
    case 'pptx':
      return 'slides';
    case 'doc':
    case 'docx':
      return 'word';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
      return 'image';
    default:
      return 'other';
  }
};

export const getAudienceLabel = (audience: string): string =>
  DOCUMENT_AUDIENCE_OPTIONS.find((option) => option.value === audience)?.label ?? audience;

export const formatFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const readFileAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Dosya okunamadı.'));
    reader.readAsDataURL(file);
  });

const parseApiResponse = async <T>(res: Response): Promise<T> => {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'İşlem tamamlanamadı.');
  return data as T;
};

const adminHeaders = (): HeadersInit => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${getAdminToken() ?? ''}`,
});

export const adminListDocuments = async () =>
  parseApiResponse<{ storage_ready: boolean; documents: PlatformDocument[] }>(
    await fetch('/api/v1/admin/documents', { headers: adminHeaders() })
  );

export const adminCreateDocument = async (payload: {
  title: string;
  description: string;
  category: string;
  target_audience: string;
  file_name: string;
  content_base64: string;
}) =>
  parseApiResponse<{ document: PlatformDocument }>(
    await fetch('/api/v1/admin/documents', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(payload),
    })
  );

export const adminUpdateDocument = async (id: string, patch: Partial<PlatformDocument>) =>
  parseApiResponse<{ document: PlatformDocument }>(
    await fetch(`/api/v1/admin/documents/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify(patch),
    })
  );

export const adminDeleteDocument = async (id: string) =>
  parseApiResponse<{ id: string }>(
    await fetch(`/api/v1/admin/documents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: adminHeaders(),
    })
  );

export const memberListDocuments = async (token: string) =>
  parseApiResponse<{ storage_ready: boolean; documents: PlatformDocument[] }>(
    await fetch('/api/v1/documents', {
      headers: { Authorization: `Bearer ${token}` },
    })
  );
