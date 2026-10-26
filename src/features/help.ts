// "How to use" dialog: every tool with a one-line description, gestures and shortcuts.
import { LayoutGrid } from 'lucide';
import { t, type Key } from '../i18n';
import { dialog, h, icon } from '../ui/dom';
import { MOD, TOOL_GROUPS, TOOL_INFO } from '../ui/toolbar';

export async function helpDialog(): Promise<void> {
  // One row per tool; tools that share a description (shapes) share a row.
  const toolRows: HTMLElement[] = [];
  const all = TOOL_GROUPS.flatMap((g) => g.tools);
  for (let i = 0; i < all.length; ) {
    const desc = TOOL_INFO[all[i]].desc;
    let j = i;
    while (j < all.length && TOOL_INFO[all[j]].desc === desc) j++;
    const same = all.slice(i, j);
    const names = same.map((tool) => t(TOOL_INFO[tool].label)).join(' · ');
    const keys = same.flatMap((tool) => (TOOL_INFO[tool].key ? [h('kbd', {}, TOOL_INFO[tool].key!)] : []));
    toolRows.push(
      h(
        'div.help-tool',
        {},
        h('span.help-icon', {}, icon(TOOL_INFO[same[0]].icon, 20)),
        h('div', {}, h('div.help-name', {}, names, ...keys), h('div.help-desc', {}, t(desc))),
      ),
    );
    i = j;
  }
  toolRows.push(
    h('div.help-tool', {}, h('span.help-icon', {}, icon(LayoutGrid, 20)), h('div', {}, h('div.help-name', {}, t('groupPages')), h('div.help-desc', {}, t('descPages')))),
  );

  const keys: [string, Key][] = [
    [`${MOD}O · ${MOD}S · ${MOD}Shift+S`, 'keyOpenSave'],
    [`${MOD}P`, 'keyPrint'],
    [`${MOD}F`, 'keyFind'],
    [`${MOD}Z · ${MOD}Y`, 'keyUndo'],
    [`${MOD}+ · ${MOD}− · ${MOD}0`, 'keyZoom'],
    [`Delete · ${MOD}D · ← ↑ → ↓`, 'keyDelete'],
    ['Esc', 'keyEscape'],
    ['?', 'keyHelp'],
  ];
  const gestures: Key[] = ['gestureScroll', 'gesturePinch', 'gestureSelectText', 'gestureEdit', 'gestureMovePage'];

  await dialog({
    title: t('helpTitle'),
    wide: true,
    body: h(
      'div.help',
      {},
      h('h3', {}, t('helpTools')),
      h('div.help-tools', {}, ...toolRows),
      h('h3', {}, t('helpSaving')),
      h('p', {}, t('helpSavingText')),
      h(
        'div.help-cols',
        {},
        h('div', {}, h('h3', {}, t('helpGestures')), h('ul', {}, ...gestures.map((g) => h('li', {}, t(g))))),
        h(
          'div',
          {},
          h('h3', {}, t('helpKeys')),
          h(
            'table.help-keys',
            {},
            ...keys.map(([k, label]) =>
              h('tr', {}, h('td', {}, ...k.split(' · ').flatMap((x, i) => [i ? ' ' : '', h('kbd', {}, x)])), h('td', {}, t(label))),
            ),
          ),
        ),
      ),
    ),
    actions: [{ label: t('ok'), value: true, primary: true }],
  });
}
