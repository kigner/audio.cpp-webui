"""Shared request applicability for the local voice-conversion workbench."""

SEED_V1_ROUTES = ['v1_whisper_bigvgan_vc', 'v1_xlsr_hift_vc', 'v1_svc']
VEVO_AR_ROUTES = ['style_converted_vc', 'style_converted_svc', 'singing_style_conversion',
                  'humming_to_singing', 'instrument_to_singing']
ROUTES = {
    'seed_vc': {'vc': ['v2_vc', *SEED_V1_ROUTES[:2]], 'svc': ['v1_svc']},
    'vevo2': {'vc': ['style_preserved_vc', 'style_converted_vc'],
              'svc': ['style_preserved_svc', *VEVO_AR_ROUTES[1:]]},
}
PARAMETER_ROUTES = {
    'seed_vc': {
        **dict.fromkeys(['voice_anonymization', 'intelligibility_guidance_scale',
                         'similarity_guidance_scale'], ['v2_vc']),
        **dict.fromkeys(['inference_guidance_scale', 'f0_condition', 'auto_f0_adjust',
                         'semitone_shift'], SEED_V1_ROUTES),
    },
    'vevo2': dict.fromkeys(['temperature', 'top_k', 'top_p', 'repetition_penalty',
                           'max_tokens'], VEVO_AR_ROUTES),
}
SEED_ALIASES = {'intelligibility_cfg_rate': 'intelligibility_guidance_scale',
                'similarity_cfg_rate': 'similarity_guidance_scale',
                'inference_cfg_rate': 'inference_guidance_scale',
                'anonymization_only': 'voice_anonymization', 'semi_tone_shift': 'semitone_shift'}


def controls_for(entry):
    family, task = entry.get('family'), entry.get('task')
    routes = ROUTES.get(family, {}).get(task, [])
    return {'routes': routes, 'default_route': routes[0] if routes else '',
            'parameter_routes': PARAMETER_ROUTES.get(family, {}),
            'aliases': SEED_ALIASES if family == 'seed_vc' else {},
            'f0_default': task == 'svc'}


def normalize_options(entry, options):
    """Keep drafts in the UI, but never submit controls unused by the selected route."""
    if not entry or entry.get('task') not in {'vc', 'svc'}:
        return
    controls = controls_for(entry)
    route = options.get('route') or controls['default_route']
    if controls['routes'] and route not in controls['routes']:
        raise ValueError(f"当前模型入口不支持转换路线 {route}，请选择适用路线。")
    for alias, name in controls['aliases'].items():
        if alias in options:
            options.setdefault(name, options.pop(alias))
    for name, routes in controls['parameter_routes'].items():
        if route not in routes:
            options.pop(name, None)
    if entry['family'] == 'seed_vc':
        f0 = options.get('f0_condition', controls['f0_default'])
        if str(f0).lower() not in {'true', '1'}:
            for name in ('auto_f0_adjust', 'semitone_shift'):
                options.pop(name, None)
