import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './ui.module.css';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'link';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  isFullWidth?: boolean;
}

function buttonClassName(variant: ButtonVariant, isFullWidth = false): string {
  return [styles.button, styles[variant], isFullWidth ? styles.fullWidth : ''].filter(Boolean).join(' ');
}

export function Button({ variant = 'secondary', isFullWidth, type = 'button', ...buttonProps }: ButtonProps) {
  return <button type={type} className={buttonClassName(variant, isFullWidth)} {...buttonProps} />;
}

interface ButtonLinkProps {
  href: string;
  variant?: ButtonVariant;
  /** For another module's frontend, which is a separate site rather than a page in this app. */
  isExternal?: boolean;
  children: ReactNode;
}

export function ButtonLink({ href, variant = 'secondary', isExternal, children }: ButtonLinkProps) {
  const className = buttonClassName(variant);
  if (isExternal) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
