import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { AlertCircle } from 'lucide-react';
import styles from './ui.module.css';

export function LogoSlot({ compact = false }: { compact?: boolean }) {
  return (
    <span className={styles.logo} aria-label="Company DSH">
      <span className={styles.logoMark} aria-hidden="true">
        DSH
      </span>
      {!compact && <span className={styles.logoText}>Company Workbench</span>}
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  pending?: boolean;
  icon?: ReactNode;
};

export function Button({
  variant = 'secondary',
  pending = false,
  icon,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`${styles.button} ${styles[variant]}`}
      disabled={disabled || pending}
      {...props}
    >
      {pending ? <span className={styles.spinner} aria-hidden="true" /> : icon}
      <span>{children}</span>
    </button>
  );
}

export function IconButton({
  variant = 'ghost',
  pending = false,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`${styles.iconButton} ${styles[variant]}`}
      disabled={disabled || pending}
      {...props}
    >
      {pending ? <span className={styles.spinner} aria-hidden="true" /> : children}
    </button>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'warning' | 'error' | 'info';
  children: ReactNode;
}) {
  return (
    <span className={`${styles.badge} ${tone === 'neutral' ? '' : styles[tone]}`}>{children}</span>
  );
}

type FieldProps = {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
};

export function Field({ label, error, hint, children }: FieldProps) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      {children}
      {error ? (
        <span className={styles.fieldError}>{error}</span>
      ) : hint ? (
        <span className={styles.hint}>{hint}</span>
      ) : null}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input(props, ref) {
    return <input ref={ref} className={styles.control} {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select(props, ref) {
    return <select ref={ref} className={styles.control} {...props} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea(props, ref) {
  return <textarea ref={ref} className={styles.control} {...props} />;
});

export function InlineAlert({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.alert} role="alert">
      <AlertCircle aria-hidden="true" />
      <div>
        <p className={styles.alertTitle}>{title}</p>
        <p className={styles.alertBody}>{children}</p>
      </div>
    </div>
  );
}

export function Skeleton({ width = '100%' }: { width?: string }) {
  return <div className={styles.skeleton} style={{ width }} aria-hidden="true" />;
}
