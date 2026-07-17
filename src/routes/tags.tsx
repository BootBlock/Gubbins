import { createFileRoute } from '@tanstack/react-router';
import { TagsScreen } from '@/features/tags/TagsScreen';

export const Route = createFileRoute('/tags')({
  component: TagsScreen,
});
