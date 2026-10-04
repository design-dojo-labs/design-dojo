import { useId } from 'react';
import { PROBLEM_THEME_MAX_LENGTH } from '@lld/shared';
import { inputClass } from './ui';

export function ProblemIdea({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="mt-5 max-w-[640px]">
      <label htmlFor={id} className="text-[13px] font-medium">
        Your problem idea or statement <span className="font-normal text-faint">(optional)</span>
      </label>
      <textarea
        id={id}
        className={`${inputClass} mt-2 min-h-24 w-full resize-y py-2`}
        rows={3}
        maxLength={PROBLEM_THEME_MAX_LENGTH}
        placeholder="e.g. Car parking system — support multiple floors, different vehicle sizes, and hourly fees."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-describedby={`${id}-help`}
      />
      <div className="mt-1 flex items-start justify-between gap-3 text-[12px] text-faint">
        <p id={`${id}-help`}>
          AI will expand your idea into a complete question using the settings above. Leave blank for a surprise question. Applies only to AI generation.
        </p>
        <span className="tabular shrink-0">{value.length}/{PROBLEM_THEME_MAX_LENGTH}</span>
      </div>
    </div>
  );
}
