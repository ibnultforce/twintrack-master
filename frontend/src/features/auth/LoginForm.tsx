'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { InputField } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Notice';
import { errorMessage, fieldErrorMessage } from '@/lib/api/client';
import { useAuth } from './AuthProvider';

export function LoginForm() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(undefined);
    try {
      // The sign-in page moves on by itself once the account has loaded.
      await signIn({ email, password });
    } catch (caught) {
      setError(caught);
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <InputField
        label="Work email"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        error={fieldErrorMessage(error, 'email')}
      />
      <InputField
        label="Password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        error={fieldErrorMessage(error, 'password')}
      />
      {error !== undefined && <Notice tone="danger">{errorMessage(error)}</Notice>}
      <Button type="submit" variant="primary" isFullWidth disabled={isSubmitting}>
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
