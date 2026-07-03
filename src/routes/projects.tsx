import { createFileRoute } from '@tanstack/react-router';
import { ModuleGuard } from '@/features/modules/ModuleGuard';
import { ProjectsScreen } from '@/features/projects/ProjectsScreen';

export const Route = createFileRoute('/projects')({
  component: () => (
    <ModuleGuard feature="projects">
      <ProjectsScreen />
    </ModuleGuard>
  ),
});
