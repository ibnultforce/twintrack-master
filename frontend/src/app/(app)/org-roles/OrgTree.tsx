'use client';

import type { OrgRole } from '@/lib/api/types';
import { peopleCount } from '@/lib/format';

/** How a role relates to the chosen one in the tree of job levels: the chosen role, a level above it, or a level below it. */
export type RoleRelation = 'chosen' | 'above' | 'below' | 'other';

type OrgTreeProps = {
  roles: OrgRole[];
  chosenId: string;
  relationOf: (roleId: string) => RoleRelation;
  /** Roles whose children are hidden. */
  collapsedIds: Set<string>;
  onChoose: (roleId: string) => void;
  onToggle: (roleId: string) => void;
};

const RELATION_LABELS: Record<Exclude<RoleRelation, 'other'>, string> = {
  chosen: 'Chosen role',
  above: 'Higher job level',
  below: 'Lower job level',
};

/** The relation colours used in the tree, shown above it. */
export function OrgTreeLegend() {
  return (
    <ul className="org-tree-legend" aria-label="Legend">
      {(Object.keys(RELATION_LABELS) as (keyof typeof RELATION_LABELS)[]).map((relation) => (
        <li key={relation}><span className="org-tree-swatch" data-relation={relation} />{RELATION_LABELS[relation]}</li>
      ))}
    </ul>
  );
}

/** The org roles drawn as a tree with connector lines, starting from the roles with no parent. */
export function OrgTree(props: OrgTreeProps) {
  const childrenOf = (parentId: string | null) =>
    props.roles.filter((role) => role.parentId === parentId).sort((first, second) => first.name.localeCompare(second.name));

  const renderBranch = (parentId: string | null) => {
    const children = childrenOf(parentId);
    if (children.length === 0) return null;
    return (
      <ul className={parentId === null ? 'org-tree' : 'org-tree-group'}>
        {children.map((role) => {
          const hasChildren = props.roles.some((candidate) => candidate.parentId === role.id);
          const isCollapsed = props.collapsedIds.has(role.id);
          const relation = props.relationOf(role.id);
          return (
            <li key={role.id} className="org-tree-branch" data-relation={relation}>
              <div className="org-tree-node" data-relation={relation}>
                {hasChildren ? (
                  <button
                    type="button"
                    className="org-tree-toggle"
                    aria-expanded={!isCollapsed}
                    aria-label={`${isCollapsed ? 'Show' : 'Hide'} roles below ${role.name}`}
                    onClick={() => props.onToggle(role.id)}
                  >
                    {isCollapsed ? '▸' : '▾'}
                  </button>
                ) : <span className="org-tree-toggle" aria-hidden="true" />}
                <button
                  type="button"
                  className="org-tree-name"
                  aria-current={role.id === props.chosenId}
                  title={`${role.name}: ${peopleCount(role.peopleCount)}`}
                  onClick={() => props.onChoose(role.id)}
                >
                  {role.name}
                </button>
                <span className="org-tree-count" title={peopleCount(role.peopleCount)}>{role.peopleCount}</span>
              </div>
              {hasChildren && !isCollapsed ? renderBranch(role.id) : null}
            </li>
          );
        })}
      </ul>
    );
  };

  return renderBranch(null);
}
