"""Capture the Kodi add-on 0.2.533 `build_gender_block` output for the H.7 verbatim gate.

The add-on source is untracked (`Source Codes/`, .gitignore), so its output is captured here into a
tracked JSON file that a clean clone can check against. Run from the repository root:

    python scripts/gates/fixtures/gender_blocks/make_gender_blocks.py
"""
import importlib.util
import json
import os

SRC = os.path.join('Source Codes', 'service.subtitles.kodipovilai', 'Older versions', '0.2.533',
                   'resources', 'lib', 'prompt.py')
spec = importlib.util.spec_from_file_location('kodi_prompt_0_2_533', SRC)
prompt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prompt)

ROWS = {
    'ar': [(0, 'أنتِ متعبة جداً'), (2, 'اسمع، أنا هنا')],
    'he': [(0, 'את עייפה מאוד'), (2, 'תקשיב, אני פה')],
    'es': [(0, 'Estás cansada'), (2, 'Escucha, estoy aquí')],
    'ru': [(0, 'Ты устала'), (2, 'Слушай, я здесь')],
    'pl': [(0, 'Zrobiłaś to'), (2, 'Słuchaj')],
    'nl': [(0, 'Zij is moe'), (2, 'Luister')],
    'de': [(0, 'Sie ist müde'), (2, 'Hör zu')],
}

out = {lang: {'rows': [[n, t] for n, t in rows], 'block': prompt.build_gender_block(rows, lang)}
       for lang, rows in ROWS.items()}
out['_source'] = '0.2.533 resources/lib/prompt.py build_gender_block'
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, 'gender_blocks_0.2.533.json'), 'w', encoding='utf-8', newline='\n') as f:
    json.dump(out, f, ensure_ascii=False, indent=1, sort_keys=True)
    f.write('\n')
