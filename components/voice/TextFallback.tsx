'use client';

/**
 * The honest fallback when the monument cannot hear.
 *
 * Three things can take the microphone away: no Sarvam key (STT returns 503
 * not_configured), a denied permission prompt, or a browser with no
 * MediaRecorder. In all three the visitor gets a text box and a plain sentence
 * explaining why — never a spinner that never resolves, and never a language
 * picker, because the answering route reads the script they type in.
 */

import { useState } from 'react';

export interface TextFallbackProps {
  onSubmit: (text: string) => void | Promise<void>;
  /** The plain reason the mic is unavailable. Shown above the field. */
  message: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export function TextFallback({
  onSubmit,
  message,
  disabled = false,
  placeholder = 'Type your question in any language',
  className = '',
}: TextFallbackProps) {
  const [value, setValue] = useState('');

  const submit = async () => {
    const text = value.trim();
    if (!text || disabled) return;
    setValue('');
    await onSubmit(text);
  };

  return (
    <form
      className={`bol-glass flex w-full max-w-md flex-col gap-2 p-3 ${className}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-[11px] leading-relaxed text-sandstone-200/65">{message}</p>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={placeholder}
          className="indic-text min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm
                     text-sandstone-100 placeholder:text-sandstone-200/30 outline-none
                     focus:border-sandstone-300/50 disabled:opacity-40"
        />
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          className="rounded-xl border border-sandstone-200/25 bg-sandstone-500/25 px-3 py-2 text-sm
                     text-sandstone-100 transition-colors hover:bg-sandstone-500/40 disabled:opacity-30"
        >
          Ask
        </button>
      </div>
    </form>
  );
}

export default TextFallback;
