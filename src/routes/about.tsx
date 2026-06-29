import { createFileRoute } from '@tanstack/react-router';
import { AboutScreen } from '@/features/about/AboutScreen';

export const Route = createFileRoute('/about')({
  component: AboutScreen,
});
