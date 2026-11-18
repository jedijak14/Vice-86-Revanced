# Asset accounting

Every 3D model, animation and texture the shipped page can ask for, with where it came
from and what it weighs. `tools/vendor_models.py --verify` re-checks these bytes.

## kaykit-adventures

- source: `KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0` at `main`
- licence: **CC0** (`LICENSE.txt` in the source repository)
- 5 file(s), 1.68 MB
- KayKit Character Pack: Adventures, textured rigged humanoids and gear.

| file | bytes | sha256 | from |
| --- | ---: | --- | --- |
| `kaykit-adventures/Barbarian.glb` | 334384 | `932eb04f9f55` | `addons/kaykit_character_pack_adventures/Characters/gltf/Barbarian.glb` |
| `kaykit-adventures/Knight.glb` | 380284 | `f26a3ba72293` | `addons/kaykit_character_pack_adventures/Characters/gltf/Knight.glb` |
| `kaykit-adventures/Mage.glb` | 310832 | `69bf61ac869d` | `addons/kaykit_character_pack_adventures/Characters/gltf/Mage.glb` |
| `kaykit-adventures/Rogue.glb` | 337388 | `bd74b1b75b97` | `addons/kaykit_character_pack_adventures/Characters/gltf/Rogue.glb` |
| `kaykit-adventures/Rogue_Hooded.glb` | 318960 | `fea22b3983f9` | `addons/kaykit_character_pack_adventures/Characters/gltf/Rogue_Hooded.glb` |

## kaykit-animation

- source: `NoLimitNexus/game-models` at `main`
- licence: **CC0** (`licenses/kaykit-character-animations.txt` in the source repository)
- 5 file(s), 1.91 MB
- KayKit Character Animations 1.1: 131 clips on the Rig_Medium humanoid skeleton (CC0, Kay Lousberg), mirrored by NoLimitNexus.

| file | bytes | sha256 | from |
| --- | ---: | --- | --- |
| `kaykit-animation/Rig_Medium_CombatRanged.glb` | 554624 | `fc703d17c47b` | `library/animations/Rig_Medium_CombatRanged.glb` |
| `kaykit-animation/Rig_Medium_General.glb` | 400960 | `aa111549e09c` | `library/animations/Rig_Medium_General.glb` |
| `kaykit-animation/Rig_Medium_MovementAdvanced.glb` | 287088 | `9f068c75f18c` | `library/animations/Rig_Medium_MovementAdvanced.glb` |
| `kaykit-animation/Rig_Medium_MovementBasic.glb` | 253320 | `f4601166eeac` | `library/animations/Rig_Medium_MovementBasic.glb` |
| `kaykit-animation/Rig_Medium_Simulation.glb` | 415024 | `3fadbea6b1de` | `library/animations/Rig_Medium_Simulation.glb` |

Total in the shipped page: **3.59 MB** of model data across 2 pack(s).
