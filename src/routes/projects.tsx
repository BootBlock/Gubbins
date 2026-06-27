import { createFileRoute } from '@tanstack/react-router';
import { ProjectsScreen } from '@/features/projects/ProjectsScreen';

export const Route = createFileRoute('/projects')({
  component: ProjectsScreen,
});
