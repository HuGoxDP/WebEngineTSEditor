import { Injectable } from '@angular/core';

/**
 * Tiny browser-side helpers for save/load through the OS file system.
 * Uses download links for save and a hidden `<input type="file">` for open.
 */
@Injectable({ providedIn: 'root' })
export class FileIoService {

    /** Triggers a browser download of `text` as `fileName`. */
    public saveText(fileName: string, text: string, mime: string = 'application/json'): void {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Release the blob after a tick so the browser has time to start the download.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /**
     * Opens a file picker and resolves with the file's text contents.
     * Resolves with `null` if the user cancels.
     */
    public openText(accept: string = '.json'): Promise<{ name: string; text: string } | null> {
        return new Promise(resolve => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = accept;
            input.style.display = 'none';
            document.body.appendChild(input);

            const cleanup = () => input.remove();

            input.addEventListener('change', () => {
                const file = input.files?.[0];
                if (!file) { cleanup(); resolve(null); return; }
                const reader = new FileReader();
                reader.onload = () => {
                    cleanup();
                    resolve({ name: file.name, text: String(reader.result ?? '') });
                };
                reader.onerror = () => { cleanup(); resolve(null); };
                reader.readAsText(file);
            });

            input.addEventListener('cancel', () => { cleanup(); resolve(null); });
            input.click();
        });
    }
}
